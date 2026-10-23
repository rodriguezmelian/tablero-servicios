const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'version-hub-secret-2026';

// Configuración de Correo SMTP adaptada para puerto 465 con SSL y certificados
const smtpPort = parseInt(process.env.SMTP_PORT || 465, 10);
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'mail.weit.com.ar',
    port: smtpPort,
    secure: true, // Obligatorio true para el puerto 465
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
    tls: {
        // Evita que Node.js rechace la conexión si el servidor usa certificados autofirmados
        rejectUnauthorized: false
    }
});

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Inicializar Base de Datos SQLite persistente
const dbFile = path.join(__dirname, 'data', 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Error al abrir la base de datos:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite.');
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS branches (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            region TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS apps (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            latest TEXT NOT NULL,
            description TEXT,
            check_url TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS deployments (
            app_id TEXT,
            branch_id TEXT,
            version TEXT NOT NULL,
            version_url TEXT,
            PRIMARY KEY (app_id, branch_id)
        )`, () => {
            // Asegurar columna version_url si la tabla ya existía previamente
            db.run(`ALTER TABLE deployments ADD COLUMN version_url TEXT`, (err) => {});
        });

        // Tabla de configuración para el email del administrador
        db.run(`CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )`, () => {
            db.get(`SELECT value FROM settings WHERE key = 'admin_email'`, (err, row) => {
                if (!row) {
                    db.run(`INSERT INTO settings (key, value) VALUES ('admin_email', 'admin@versionhub.local')`);
                }
            });
        });

        // Datos iniciales si está vacía
        db.get(`SELECT COUNT(*) as count FROM branches`, (err, row) => {
            if (row.count === 0) {
                const defaultBranches = [
                    { id: 'salta', name: 'Salta', region: 'contacto@salta.gob.ar' },
                    { id: 'tucuman', name: 'Tucumán', region: 'contacto@tucuman.gov.ar' },
                    { id: 'mendoza', name: 'Mendoza', region: 'contacto@mendoza.gov.ar' }
                ];
                defaultBranches.forEach(b => {
                    db.run(`INSERT INTO branches (id, name, region) VALUES (?, ?, ?)`, [b.id, b.name, b.region]);
                });

                const defaultApps = [
                    { id: 'app-rancher', name: 'Rancher', latest: 'v1.0.0', description: 'Version 2025', check_url: '' },
                    { id: 'app-postgres', name: 'Postgres', latest: 'v3.0', description: 'Base de datos', check_url: '' }
                ];
                defaultApps.forEach(a => {
                    db.run(`INSERT INTO apps (id, name, latest, description, check_url) VALUES (?, ?, ?, ?, ?)`, [a.id, a.name, a.latest, a.description, a.check_url]);
                });
            }
        });
    });

    // Programar Tarea Automática Bi-quincenal (Días 1 y 16 de cada mes a las 08:00 AM)
    cron.schedule('0 8 1,16 * *', () => {
        console.log('[CRON] Ejecutando reporte automático quincenal...');
        sendBiWeeklyReport();
    });
}

function authenticateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey || apiKey !== API_KEY) {
        return res.status(401).json({ error: 'No autorizado. Se requiere API Key.' });
    }
    next();
}

// ================= GENERACIÓN DE PDF Y ENVÍO A ADMIN =================

function generatePDFReport(stateData) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const buffers = [];

        doc.on('data', chunk => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));

        doc.fontSize(20).fillColor('#4f46e5').text('Version Hub - Reporte Quincenal', { align: 'center' });
        doc.fontSize(10).fillColor('#64748b').text(`Generado automáticamente el ${new Date().toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(2);

        doc.fontSize(14).fillColor('#1e293b').text('Resumen General');
        doc.fontSize(10).fillColor('#334155').text(`Total Provincias Activas: ${stateData.branches.length}`);
        doc.text(`Total Aplicaciones Monitoreadas: ${stateData.apps.length}`);
        doc.moveDown(1.5);

        doc.fontSize(14).fillColor('#1e293b').text('Estado de Versiones');
        doc.moveDown(0.5);

        stateData.apps.forEach(app => {
            doc.fontSize(11).fillColor('#4f46e5').text(`• Aplicación: ${app.name} (Última oficial: ${app.latest})`);
            stateData.branches.forEach(branch => {
                const key = app.id + '_' + branch.id;
                const ver = stateData.deployments[key] || 'v1.0.0';
                doc.fontSize(9).fillColor('#64748b').text(`   - ${branch.name}: ${ver}`);
            });
            doc.moveDown(0.5);
        });

        doc.end();
    });
}

function sendBiWeeklyReport() {
    db.get(`SELECT value FROM settings WHERE key = 'admin_email'`, (err, row) => {
        const adminEmail = row ? row.value : null;
        if (!adminEmail) {
            console.log('[Email] No hay un correo de administrador configurado.');
            return;
        }

        db.all(`SELECT * FROM branches`, [], (err, branches) => {
            if (err || !branches.length) return;
            db.all(`SELECT * FROM apps`, [], (err, apps) => {
                if (err || !apps.length) return;
                db.all(`SELECT * FROM deployments`, [], async (err, deps) => {
                    if (err) return;

                    const deploymentsMap = {};
                    deps.forEach(d => { deploymentsMap[d.app_id + '_' + d.branch_id] = d.version; });

                    try {
                        const pdfBuffer = await generatePDFReport({ branches, apps, deployments: deploymentsMap });

                        await transporter.sendMail({
                            from: `"Version Hub" <${process.env.SMTP_USER}>`,
                            to: adminEmail,
                            subject: 'Reporte Quincenal de Control de Versiones',
                            text: 'Adjunto encontrarás el reporte quincenal actualizado del tablero de control de versiones.',
                            attachments: [{ filename: `reporte-version-hub.pdf`, content: pdfBuffer }]
                        });
                        console.log(`[Email] Reporte enviado con éxito al administrador: ${adminEmail}`);
                    } catch (e) {
                        console.error('[Email] Error al enviar el reporte PDF:', e.message);
                    }
                });
            });
        });
    });
}

// ================= API REST =================
// Claves de acceso 
const VIEWER_KEY = process.env.VIEWER_KEY || 'lectura2026'; // Contraseña para solo lectura

// Único Endpoint de Login con soporte para Admin y Viewer
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === API_KEY) {
        res.json({ success: true, role: 'admin', apiKey: API_KEY });
    } else if (password === VIEWER_KEY) {
        res.json({ success: true, role: 'viewer', apiKey: '' });
    } else {
        res.status(401).json({ error: 'Contraseña incorrecta' });
    }
});

app.get('/api/state', (req, res) => {
    db.all(`SELECT * FROM branches`, [], (err, branches) => {
        db.all(`SELECT * FROM apps`, [], (err, apps) => {
            db.all(`SELECT * FROM deployments`, [], (err, deps) => {
                db.all(`SELECT * FROM settings`, [], (err, settingsRows) => {
                    const deploymentsMap = {};
                    const urlsMap = {};
                    deps.forEach(d => {
                        deploymentsMap[d.app_id + '_' + d.branch_id] = d.version;
                        urlsMap[d.app_id + '_' + d.branch_id] = d.version_url || '';
                    });

                    const settings = {};
                    settingsRows.forEach(s => settings[s.key] = s.value);

                    res.json({ branches, apps, deployments: deploymentsMap, deploymentUrls: urlsMap, settings });
                });
            });
        });
    });
});


// Actualizar configuración (Admin Email)
app.post('/api/settings', authenticateApiKey, (req, res) => {
    const { admin_email } = req.body;
    if (!admin_email) return res.status(400).json({ error: 'El email es obligatorio' });

    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_email', ?)`, [admin_email], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Configuración actualizada correctamente.' });
    });
});

app.post('/api/apps/check-updates', authenticateApiKey, async (req, res) => {
    db.all(`SELECT * FROM apps WHERE check_url IS NOT NULL AND check_url != ''`, [], async (err, apps) => {
        let updatedCount = 0;
        for (const app of apps) {
            try {
                const response = await fetch(app.check_url, { headers: { 'User-Agent': 'VersionHub-Bot' } });
                if (response.ok) {
                    const contentType = response.headers.get('content-type');
                    let newVersion = contentType && contentType.includes('application/json') ? (await response.json()).tag_name : (await response.text()).trim();
                    if (newVersion && newVersion !== app.latest) {
                        await new Promise(resolve => db.run(`UPDATE apps SET latest = ? WHERE id = ?`, [newVersion, app.id], () => { updatedCount++; resolve(); }));
                    }
                }
            } catch (e) {}
        }
        res.json({ success: true, message: `Verificación global finalizada. ${updatedCount} actualizadas.` });
    });
});

app.post('/api/deployments/check-updates', authenticateApiKey, async (req, res) => {
    db.all(`SELECT * FROM deployments WHERE version_url IS NOT NULL AND version_url != ''`, [], async (err, deps) => {
        let updatedCount = 0;
        for (const dep of deps) {
            try {
                const response = await fetch(dep.version_url, { headers: { 'User-Agent': 'VersionHub-Bot' } });
                if (response.ok) {
                    const data = await response.json();
                    const fetchedVersion = data.version || data.tag_name || data.current_version;
                    if (fetchedVersion && fetchedVersion !== dep.version) {
                        await new Promise(resolve => db.run(`UPDATE deployments SET version = ? WHERE app_id = ? AND branch_id = ?`, [fetchedVersion, dep.app_id, dep.branch_id], () => { updatedCount++; resolve(); }));
                    }
                }
            } catch (e) {}
        }
        res.json({ success: true, message: `Sincronización por provincia completada. ${updatedCount} actualizadas.` });
    });
});


// Endpoint corregido para guardar correctamente la version_url
app.post('/api/deployments', authenticateApiKey, (req, res) => {
    let { appId, branchId, version, version_url } = req.body;

    if (!appId || !branchId || !version) {
        return res.status(400).json({ error: 'Faltan parámetros: appId, branchId, version' });
    }

    db.get(`SELECT id FROM apps WHERE id = ? OR LOWER(name) = LOWER(?)`, [appId, appId], (err, appRow) => {
        if (err || !appRow) return res.status(404).json({ error: 'Aplicación no encontrada' });

        db.get(`SELECT id FROM branches WHERE id = ? OR LOWER(name) = LOWER(?)`, [branchId, branchId], (err, branchRow) => {
            if (err || !branchRow) return res.status(404).json({ error: 'Provincia no encontrada' });

            db.run(`INSERT INTO deployments (app_id, branch_id, version, version_url) VALUES (?, ?, ?, ?)
                    ON CONFLICT(app_id, branch_id) DO UPDATE SET version = ?, version_url = ?`,
                [appRow.id, branchRow.id, version, version_url || '', version, version_url || ''],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, message: 'Despliegue guardado correctamente' });
                }
            );
        });
    });
});

app.post('/api/branches', authenticateApiKey, (req, res) => {
    const { name, contactEmail } = req.body;
    const id = name.toLowerCase().replace(/\s+/g, '-').normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    db.run(`INSERT OR REPLACE INTO branches (id, name, region) VALUES (?, ?, ?)`, [id, name, contactEmail || ''], () => res.json({ success: true }));
});

app.delete('/api/branches/:id', authenticateApiKey, (req, res) => {
    db.run(`DELETE FROM branches WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.post('/api/apps', authenticateApiKey, (req, res) => {
    const { name, latest, description, check_url } = req.body;
    const id = 'app-' + Math.random().toString(36).substring(2, 7);
    db.run(`INSERT INTO apps (id, name, latest, description, check_url) VALUES (?, ?, ?, ?, ?)`, [id, name, latest || 'v1.0.0', description || '', check_url || ''], () => res.json({ success: true }));
});

app.put('/api/apps/:id', authenticateApiKey, (req, res) => {
    const { name, latest, description, check_url } = req.body;
    db.run(`UPDATE apps SET name = ?, latest = ?, description = ?, check_url = ? WHERE id = ?`, [name, latest, description || '', check_url || '', req.params.id], () => res.json({ success: true }));
});

app.delete('/api/apps/:id', authenticateApiKey, (req, res) => {
    db.run(`DELETE FROM apps WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.post('/api/reports/send', authenticateApiKey, async (req, res) => {
    try {
        await sendBiWeeklyReport();
        res.json({ success: true, message: 'Reporte PDF enviado al administrador correctamente.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => { console.log(`Servidor corriendo en http://localhost:${PORT}`); });