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

// Verificar conexión a BD
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error connecting to database:', err.stack);
    } else {
        console.log('Connected to database successfully');
        release();
    }
});

// ==================== USUARIOS ====================

// GET - Obtener usuario por ID
app.get('/users/:id', async (req, res) => {
    const id = parseInt(req.params.id);

    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }

    try {
        const result = await pool.query('SELECT id, email, password FROM users WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST - Crear usuario
app.post('/users', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email y password son requeridos' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, password',
            [email, password]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Error al crear el usuario' });
    }
});

// PUT - Actualizar usuario
app.put('/users/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { email, password } = req.body;

    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }

    if (!email && !password) {
        return res.status(400).json({ error: 'Email o password son requeridos para actualizar' });
    }

    try {
        let query;
        let params;

        if (email && password) {
            query = 'UPDATE users SET email = $1, password = $2 WHERE id = $3 RETURNING id, email, password';
            params = [email, password, id];
        } else if (email) {
            query = 'UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email, password';
            params = [email, id];
        } else {
            query = 'UPDATE users SET password = $1 WHERE id = $2 RETURNING id, email, password';
            params = [password, id];
        }

        const result = await pool.query(query, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Error al actualizar el usuario' });
    }
});

// DELETE - Eliminar usuario
app.delete('/users/:id', async (req, res) => {
    const id = parseInt(req.params.id);

    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }

    try {
        const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ message: 'Usuario eliminado correctamente', id: result.rows[0].id });
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Error al eliminar el usuario' });
    }
});

// ==================== FACTURAS ====================

// GET - Obtener factura por ID (con detalle)
app.get('/facturas/:id', async (req, res) => {
    const id = parseInt(req.params.id);

    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }

    try {
        const query = `
            SELECT f.id, f.num_factura, f.customer, f.employee,
                   d.id as detail_id, d.factura_id, d.product, d.quantity, d.price, d.total
            FROM facturas f
            INNER JOIN detalles d ON d.factura_id = f.id
            WHERE f.id = $1
        `;

        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Factura no encontrada' });
        }

        const row = result.rows[0];
        const factura = {
            id: row.id,
            num_factura: row.num_factura,
            customer: row.customer,
            employee: row.employee,
            detail: {
                id: row.detail_id,
                factura_id: row.factura_id,
                product: row.product,
                quantity: row.quantity,
                price: parseFloat(row.price),
                total: parseFloat(row.total)
            }
        };

        res.json(factura);
    } catch (err) {
        console.error('Database error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// POST - Crear factura con detalle (transaccional)
app.post('/facturas', async (req, res) => {
    const { num_factura, customer, employee, detail } = req.body;

    // Validaciones
    if (!num_factura || !customer || !employee || !detail) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    if (!detail.product || !detail.quantity || !detail.price || !detail.total) {
        return res.status(400).json({ error: 'Datos de detalle incompletos' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Insertar factura
        const facturaResult = await client.query(
            'INSERT INTO facturas (num_factura, customer, employee) VALUES ($1, $2, $3) RETURNING id, num_factura, customer, employee',
            [num_factura, customer, employee]
        );

        const factura = facturaResult.rows[0];

        // Insertar detalle
        const detalleResult = await client.query(
            `INSERT INTO detalles (factura_id, product, quantity, price, total) 
             VALUES ($1, $2, $3, $4, $5) 
             RETURNING id, factura_id, product, quantity, price, total`,
            [factura.id, detail.product, detail.quantity, detail.price, detail.total]
        );

        await client.query('COMMIT');

        const response = {
            id: factura.id,
            num_factura: factura.num_factura,
            customer: factura.customer,
            employee: factura.employee,
            detail: {
                id: detalleResult.rows[0].id,
                factura_id: detalleResult.rows[0].factura_id,
                product: detalleResult.rows[0].product,
                quantity: detalleResult.rows[0].quantity,
                price: parseFloat(detalleResult.rows[0].price),
                total: parseFloat(detalleResult.rows[0].total)
            }
        };

        res.status(201).json(response);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Transaction error:', err);
        res.status(500).json({ error: 'Error al crear la factura y su detalle' });
    } finally {
        client.release();
    }
});

// PUT - Actualizar factura completa
app.put('/facturas/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { num_factura, customer, employee, detail } = req.body;

    if (isNaN(id)) {
        return res.status(400).json({ error: 'ID inválido' });
    }

    if (!num_factura || !customer || !employee || !detail) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Actualizar factura
        const facturaResult = await client.query(
            'UPDATE facturas SET num_factura = $1, customer = $2, employee = $3 WHERE id = $4',
            [num_factura, customer, employee, id]
        );
        if (facturaResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Factura no encontrada' });
        }

        // Actualizar detalle
        const detalleResult = await client.query(
            `UPDATE detalles 
             SET product = $1, quantity = $2, price = $3, total = $4 
             WHERE factura_id = $5 
             RETURNING id, factura_id, product, quantity, price, total`,
            [detail.product, detail.quantity, detail.price, detail.total, id]
        );

        if (detalleResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Detalle no encontrado para esta factura' });
        }

        await client.query('COMMIT');

        const response = {
            id: id,
            num_factura: num_factura,
            customer: customer,
            employee: employee,
            detail: {
                id: detalleResult.rows[0].id,
                factura_id: detalleResult.rows[0].factura_id,
                product: detalleResult.rows[0].product,
                quantity: detalleResult.rows[0].quantity,
                price: parseFloat(detalleResult.rows[0].price),
                total: parseFloat(detalleResult.rows[0].total)
            }
        };

        res.json(response);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Transaction error:', err);
        res.status(500).json({ error: 'Error al actualizar la factura' });
    } finally {
        client.release();
    }
});

// DELETE - Eliminar factura
app.delete('/facturas/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

    try {
        // ── CASCADE elimina el detalle, RowsAffected verifica existencia ───────
        const result = await pool.query('DELETE FROM facturas WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Factura no encontrada' });
        }
        res.json({ message: 'Factura eliminada correctamente', id });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar la factura' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
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