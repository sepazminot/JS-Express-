// server.js (nuevo - solo REST, sin gRPC)
import express from 'express';
import pg from 'pg';
import cors from 'cors';

process.env.NODE_ENV === 'production' && console.log('⚠️  Running in production mode');

const { Pool } = pg;
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Configuración de base de datos
// const pool = new Pool({
//     user: 'postgres',
//     host: 'localhost',
//     database: 'userdb',
//     password: '1234',
//     port: 5432
// });
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    max: 20,              // máximo conexiones simultáneas
    idleTimeoutMillis: 300000,
    connectionTimeoutMillis: 5000,
});

// ==================== USUARIOS ====================\

// GET - Obtener usuario
app.get('/users/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, password FROM users WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener usuario' });
    }
});

// POST - Crear usuario
app.post('/users', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, password',
            [email, password]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al crear usuario' });
    }
});

// PUT - Actualizar usuario (Lógica simplificada: siempre van ambos campos)
app.put('/users/:id', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            'UPDATE users SET email = $1, password = $2 WHERE id = $3 RETURNING id, email, password',
            [email, password, req.params.id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar usuario' });
    }
});

// DELETE - Eliminar usuario
app.delete('/users/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({ message: 'Usuario eliminado' });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar usuario' });
    }
});

// ==================== FACTURAS (MAESTRO-DETALLE) ====================\

// GET - Obtener factura con su único detalle
app.get('/facturas/:id', async (req, res) => {
    try {
        const query = `
            SELECT f.id, f.num_factura, f.customer, f.employee,
                   d.id AS detail_id, d.product, d.quantity, d.price, d.total
            FROM facturas f
            INNER JOIN detalles d ON d.factura_id = f.id
            WHERE f.id = $1`;
        
        const result = await pool.query(query, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Factura no encontrada' });

        const row = result.rows[0];
        res.json({
            id: row.id,
            num_factura: row.num_factura,
            customer: row.customer,
            employee: row.employee,
            detail: {
                id: row.detail_id,
                factura_id: row.id,
                product: row.product,
                quantity: row.quantity,
                price: parseFloat(row.price),
                total: parseFloat(row.total)
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener factura' });
    }
});

// POST - Crear Factura y Detalle (Transaccional)
app.post('/facturas', async (req, res) => {
    const { num_factura, customer, employee, detail } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Insertar Maestro
        const facturaResult = await client.query(
            'INSERT INTO facturas (num_factura, customer, employee) VALUES ($1, $2, $3) RETURNING id, num_factura, customer, employee',
            [num_factura, customer, employee]
        );
        const nuevaFactura = facturaResult.rows[0];

        // 2. Insertar Detalle único usando el ID recién creado
        const detalleResult = await client.query(
            'INSERT INTO detalles (factura_id, product, quantity, price, total) VALUES ($1, $2, $3, $4, $5) RETURNING id, product, quantity, price, total',
            [nuevaFactura.id, detail.product, detail.quantity, detail.price, detail.total]
        );
        const nuevoDetalle = detalleResult.rows[0];

        await client.query('COMMIT');

        res.status(201).json({
            ...nuevaFactura,
            detail: { ...nuevoDetalle, price: parseFloat(nuevoDetalle.price), total: parseFloat(nuevoDetalle.total) }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error al crear la factura transaccional' });
    } finally {
        client.release();
    }
});

// PUT - Actualizar Factura y Detalle (Transaccional - CORREGIDO)
app.put('/facturas/:id', async (req, res) => {
    const id = req.params.id;
    const { num_factura, customer, employee, detail } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Actualizar Maestro (Se corrigió el bug de rows.length usando rowCount)
        const facturaResult = await client.query(
            'UPDATE facturas SET num_factura = $1, customer = $2, employee = $3 WHERE id = $4',
            [num_factura, customer, employee, id]
        );

        if (facturaResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Factura no encontrada' });
        }

        // 2. Actualizar Detalle único (Devuelve el ID para la respuesta exacta)
        const detalleResult = await client.query(
            `UPDATE detalles 
             SET product = $1, quantity = $2, price = $3, total = $4 
             WHERE factura_id = $5 
             RETURNING id, factura_id, product, quantity, price, total`,
            [detail.product, detail.quantity, detail.price, detail.total, id]
        );

        if (detalleResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Detalle no encontrado' });
        }

        const detalleActualizado = detalleResult.rows[0];
        await client.query('COMMIT');

        res.json({
            id: parseInt(id),
            num_factura,
            customer,
            employee,
            detail: {
                id: detalleActualizado.id,
                factura_id: detalleActualizado.factura_id,
                product: detalleActualizado.product,
                quantity: detalleActualizado.quantity,
                price: parseFloat(detalleActualizado.price),
                total: parseFloat(detalleActualizado.total)
            }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error al actualizar la factura' });
    } finally {
        client.release();
    }
});

// DELETE - Eliminar factura (Eliminación en cascada en la BD)
app.delete('/facturas/:id', async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM facturas WHERE id = $1', [req.params.id]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Factura no encontrada' });
        res.json({ message: 'Factura eliminada correctamente' });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar la factura' });
    }
});

// Puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 REST API Server running on port ${PORT}`);
    console.log(`📋 Endpoints disponibles:`);
    console.log(`   GET    /users/:id`);
    console.log(`   POST   /users`);
    console.log(`   PUT    /users/:id`);
    console.log(`   DELETE /users/:id`);
    console.log(`   GET    /facturas/:id`);
    console.log(`   POST   /facturas`);
    console.log(`   PUT    /facturas/:id`);
    console.log(`   DELETE /facturas/:id`);
});
