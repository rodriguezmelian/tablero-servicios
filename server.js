const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require("@google/generative-ai");

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
            check_url TEXT,
            changelog TEXT,
            migration_tips TEXT
        )`, () => {
            db.run(`ALTER TABLE apps ADD COLUMN changelog TEXT`, (err) => {});
            db.run(`ALTER TABLE apps ADD COLUMN migration_tips TEXT`, (err) => {});
        });

        db.run(`CREATE TABLE IF NOT EXISTS deployments (
            app_id TEXT,
            branch_id TEXT,
            version TEXT NOT NULL,
            version_url TEXT,
            PRIMARY KEY (app_id, branch_id)
        )`, () => {
            db.run(`ALTER TABLE deployments ADD COLUMN version_url TEXT`, (err) => {});
        });

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

        // Nuevas tablas para la gestión de Tickets y Técnicos (DevOps)
        db.run(`CREATE TABLE IF NOT EXISTS technicians (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS tickets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            app_id TEXT NOT NULL,
            branch_id TEXT NOT NULL,
            from_version TEXT NOT NULL,
            to_version TEXT NOT NULL,
            status TEXT DEFAULT 'Abierto',
            technician_id TEXT,
            jira_issue_key TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS ticket_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id INTEGER,
            technician_name TEXT,
            comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

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
                    { id: 'app-rancher', name: 'Rancher', latest: 'v1.0.0', description: 'Version 2025', check_url: '', changelog: 'Versión inicial estable con soporte multinodo.', migration_tips: 'Verificar compatibilidad de certificados SSL.' },
                    { id: 'app-postgres', name: 'Postgres', latest: 'v3.0', description: 'Base de datos', check_url: '', changelog: 'Optimización de índices y mejoras de rendimiento.', migration_tips: 'Realizar backup completo antes de aplicar el upgrade.' }
                ];
                defaultApps.forEach(a => {
                    db.run(`INSERT INTO apps (id, name, latest, description, check_url, changelog, migration_tips) VALUES (?, ?, ?, ?, ?, ?, ?)`, [a.id, a.name, a.latest, a.description, a.check_url, a.changelog, a.migration_tips]);
                });
            }
        });
    });

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

// ================= INTEGRACIÓN CON JIRA =================
async function createJiraIssue(ticketData, appName, branchName) {
    const jiraUrl = process.env.JIRA_URL; 
    const jiraUser = process.env.JIRA_USER; 
    const jiraToken = process.env.JIRA_API_TOKEN; 
    const projectKey = process.env.JIRA_PROJECT_KEY || 'DEVOPS';

    if (!jiraUrl || !jiraUser || !jiraToken) {
        console.log('[Jira] Credenciales no configuradas. Omitiendo creación automática en Jira.');
        return null;
    }

    try {
        const response = await fetch(`${jiraUrl}/rest/api/2/issue`, {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${jiraUser}:${jiraToken}`).toString('base64'),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fields: {
                    project: { key: projectKey },
                    summary: `[Version Hub] Migración ${appName} en ${branchName} (${ticketData.from_version} ➔ ${ticketData.to_version})`,
                    description: `Ticket generado automáticamente desde Version Hub.\n\nAplicación: ${appName}\nProvincia: ${branchName}\nVersión origen: ${ticketData.from_version}\nVersión objetivo: ${ticketData.to_version}`,
                    issuetype: { name: 'Task' }
                }
            })
        });

        if (response.ok) {
            const data = await response.json();
            console.log(`[Jira] Tarea creada con éxito: ${data.key}`);
            return data.key;
        } else {
            const errText = await response.text();
            console.error('[Jira] Error al crear la tarea:', errText);
            return null;
        }
    } catch (e) {
        console.error('[Jira] Excepción al conectar con la API:', e.message);
        return null;
    }
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

const VIEWER_KEY = process.env.VIEWER_KEY || 'lectura2026';

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

// Inicializar cliente de Gemini con la clave de entorno y modelo correcto
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/api/ai/chat', authenticateApiKey, async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: 'El mensaje es obligatorio' });
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const systemPrompt = `Eres un asistente experto en infraestructura, despliegues y DevOps para el tablero Version Hub de Gabriel. Ayuda de forma técnica, precisa y concisa con dudas sobre versiones, changelogs, migraciones o estrategias de rollback. Consulta del usuario: "${message}"`;

        const result = await model.generateContent(systemPrompt);
        const responseText = result.response.text();

        res.json({ success: true, reply: responseText });
    } catch (error) {
        console.error('Error al consultar la API de Gemini:', error.message);
        res.status(500).json({ error: 'Error al comunicarse con Gemini: ' + error.message });
    }
});

// ================= TÉCNICOS & TICKETS API =================
app.get('/api/technicians', (req, res) => {
    db.all(`SELECT * FROM technicians`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/technicians', authenticateApiKey, (req, res) => {
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
    const id = 'tech-' + Math.random().toString(36).substring(2, 7);

    db.run(`INSERT INTO technicians (id, name, email) VALUES (?, ?, ?)`, [id, name, email || ''], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Técnico registrado correctamente.' });
    });
});

app.delete('/api/technicians/:id', authenticateApiKey, (req, res) => {
    db.run(`DELETE FROM technicians WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Técnico eliminado.' });
    });
});

app.get('/api/tickets', (req, res) => {
    const query = `
        SELECT t.*, a.name as app_name, b.name as branch_name, tech.name as technician_name 
        FROM tickets t
        LEFT JOIN apps a ON t.app_id = a.id
        LEFT JOIN branches b ON t.branch_id = b.id
        LEFT JOIN technicians tech ON t.technician_id = tech.id
        ORDER BY t.created_at DESC
    `;
    db.all(query, [], (err, tickets) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all(`SELECT * FROM ticket_comments ORDER BY created_at ASC`, [], (err, comments) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const ticketsWithComments = tickets.map(ticket => ({
                ...ticket,
                comments: comments.filter(c => c.ticket_id === ticket.id)
            }));
            res.json(ticketsWithComments);
        });
    });
});

app.post('/api/tickets', authenticateApiKey, async (req, res) => {
    const { appId, branchId, fromVersion, toVersion, technicianId } = req.body;
    if (!appId || !branchId || !fromVersion || !toVersion) {
        return res.status(400).json({ error: 'Faltan parámetros obligatorios.' });
    }

    db.get(`SELECT name FROM apps WHERE id = ?`, [appId], async (err, appRow) => {
        db.get(`SELECT name FROM branches WHERE id = ?`, [branchId], async (err, branchRow) => {
            const appName = appRow ? appRow.name : appId;
            const branchName = branchRow ? branchRow.name : branchId;

            const jiraKey = await createJiraIssue({ from_version: fromVersion, to_version: toVersion }, appName, branchName);

            db.run(`INSERT INTO tickets (app_id, branch_id, from_version, to_version, status, technician_id, jira_issue_key) VALUES (?, ?, ?, ?, 'Abierto', ?, ?)`,
                [appId, branchId, fromVersion, toVersion, technicianId || null, jiraKey || ''], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, message: 'Ticket creado con éxito y sincronizado con Jira.', ticketId: this.lastID, jiraKey });
                });
        });
    });
});

// Validación contra la URL de Auto-Sync (version_url) de la aplicación en la provincia específica
app.put('/api/tickets/:id/status', authenticateApiKey, (req, res) => {
    const { status } = req.body;
    if (!['Abierto', 'En proceso', 'Cerrado'].includes(status)) {
        return res.status(400).json({ error: 'Estado inválido.' });
    }

    const ticketId = req.params.id;

    db.get(`SELECT * FROM tickets WHERE id = ?`, [ticketId], (err, ticket) => {
        if (err || !ticket) {
            return res.status(404).json({ error: 'Ticket no encontrado' });
        }

        db.run(`UPDATE tickets SET status = ? WHERE id = ?`, [status, ticketId], (err) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            // Si el ticket pasa a "Cerrado", validamos si la provincia tiene configurada su propia version_url
            if (status === 'Cerrado') {
                db.get(`SELECT * FROM deployments WHERE app_id = ? AND branch_id = ?`, [ticket.app_id, ticket.branch_id], (err, deployment) => {
                    if (err || !deployment || !deployment.version_url || deployment.version_url.trim() === '') {
                        db.run(
                            `INSERT INTO deployments (app_id, branch_id, version) VALUES (?, ?, ?)
                             ON CONFLICT(app_id, branch_id) DO UPDATE SET version = ?`,
                            [ticket.app_id, ticket.branch_id, ticket.to_version, ticket.to_version],
                            (err) => {
                                if (err) {
                                    console.error('Error al actualizar versión automática al cerrar ticket:', err);
                                } else {
                                    console.log(`[Auto-Update] App ${ticket.app_id} en provincia ${ticket.branch_id} actualizada a ${ticket.to_version} por cierre de ticket.`);
                                }
                            }
                        );
                    } else {
                        console.log(`[Auto-Update Omitido] La provincia ${ticket.branch_id} tiene configurada una URL de Auto-Sync propia para esta app.`);
                    }
                });
            }

            res.json({ success: true, message: 'Estado actualizado correctamente.' });
        });
    });
});

app.post('/api/tickets/:id/comments', authenticateApiKey, (req, res) => {
    const { technicianName, comment } = req.body;
    if (!comment) return res.status(400).json({ error: 'El comentario no puede estar vacío.' });

    db.run(`INSERT INTO ticket_comments (ticket_id, technician_name, comment) VALUES (?, ?, ?)`,
        [req.params.id, technicianName || 'Técnico DevOps', comment], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Comentario agregado.' });
        });
});

// ================= ELIMINAR PROVINCIA POR API (Con cascada) =================
app.delete('/api/branches/:id', authenticateApiKey, (req, res) => {
    const branchParam = req.params.id;
    db.serialize(() => {
        db.run(`DELETE FROM deployments WHERE branch_id = ? OR branch_id IN (SELECT id FROM branches WHERE LOWER(name) = LOWER(?))`, [branchParam, branchParam], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            db.run(`DELETE FROM branches WHERE id = ? OR LOWER(name) = LOWER(?)`, [branchParam, branchParam], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Provincia no encontrada' });
                }
                res.json({ success: true, message: 'Provincia y sus despliegues asociados eliminados correctamente.' });
            });
        });
    });
});

// ================= ELIMINAR APLICACIÓN POR API (Con cascada) =================
app.delete('/api/apps/:id', authenticateApiKey, (req, res) => {
    const appParam = req.params.id;
    db.serialize(() => {
        db.run(`DELETE FROM deployments WHERE app_id = ? OR app_id IN (SELECT id FROM apps WHERE LOWER(name) = LOWER(?))`, [appParam, appParam], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            db.run(`DELETE FROM apps WHERE id = ? OR LOWER(name) = LOWER(?)`, [appParam, appParam], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Aplicación no encontrada' });
                }
                res.json({ success: true, message: 'Aplicación y sus despliegues asociados eliminados correctamente.' });
            });
        });
    });
});

app.post('/api/settings', authenticateApiKey, (req, res) => {
    const { admin_email } = req.body;
    if (!admin_email) return res.status(400).json({ error: 'El email es obligatorio' });

    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_email', ?)`, [admin_email], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Configuración actualizada correctamente.' });
    });
});

app.post('/api/apps/check-updates', async (req, res) => {
    try {
        const apps = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM apps WHERE check_url IS NOT NULL AND check_url != ''", [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        for (const app of apps) {
            try {
                const response = await fetch(app.check_url, {
                    headers: { 'User-Agent': 'VersionHub-Bot' }
                });

                let newVersion = '';
                let newChangelog = '';

                if (app.check_url.includes('postgresql.org/docs/release')) {
                    const htmlText = await response.text();
                    const match = htmlText.match(/href="\/docs\/release\/(\d+(?:\.\d+)+)\/"/i) || 
                                  htmlText.match(/>\s*PostgreSQL\s+(\d+(?:\.\d+)+)/i);
                    
                    if (match && match[1]) {
                        newVersion = 'v' + match[1];
                        newChangelog = `Obtenido automáticamente desde ${app.check_url}`;
                    }
                } else {
                    const data = await response.json();
                    newVersion = data.tag_name || data.latest || data.version || '';
                    newChangelog = data.body || data.changelog || '';
                }

                if (newVersion) {
                    await new Promise((resolve) => {
                        db.run(`UPDATE apps SET latest = ?, changelog = ? WHERE id = ?`, 
                            [newVersion, newChangelog, app.id], () => resolve());
                    });
                }

            } catch (error) {
                console.error(`Error al verificar la app ${app.name}:`, error.message);
            }
        }

        res.json({ success: true, message: 'Actualizaciones verificadas correctamente.' });
    } catch (error) {
        console.error('Error general en check-updates:', error);
        res.status(500).json({ success: false, error: error.message });
    }
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

app.post('/api/branches', async (req, res) => {
    const { name, contactEmail } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'El nombre de la provincia es obligatorio.' });
    }

    const trimmedName = name.trim();

    db.get("SELECT id FROM branches WHERE LOWER(name) = LOWER(?)", [trimmedName], (err, row) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        if (row) {
            return res.status(400).json({ success: false, error: 'Ya existe una provincia registrada con ese nombre.' });
        }

        const id = trimmedName.toLowerCase().replace(/[^a-z0-9]/g, '-');
        db.run("INSERT INTO branches (id, name, region) VALUES (?, ?, ?)", [id, trimmedName, contactEmail || ''], (err) => {
            if (err) {
                return res.status(500).json({ success: false, error: err.message });
            }
            res.json({ success: true, message: 'Provincia creada correctamente.' });
        });
    });
});

app.post('/api/apps', async (req, res) => {
    const { name, latest, description, check_url, changelog, migration_tips } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'El nombre de la aplicación es obligatorio.' });
    }

    const trimmedName = name.trim();

    db.get("SELECT id FROM apps WHERE LOWER(name) = LOWER(?)", [trimmedName], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (row) {
            return res.status(400).json({ success: false, error: 'Ya existe una aplicación registrada con ese nombre.' });
        }

        const id = 'app-' + trimmedName.toLowerCase().replace(/[^a-z0-9]/g, '-');
        db.run(`INSERT INTO apps (id, name, latest, description, check_url, changelog, migration_tips) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, trimmedName, latest || 'v1.0.0', description || '', check_url || '', changelog || '', migration_tips || ''], (err) => {
                if (err) return res.status(500).json({ success: false, error: err.message });
                res.json({ success: true, message: 'Aplicación creada correctamente.' });
            });
    });
});

app.put('/api/apps/:id', async (req, res) => {
    const appId = req.params.id;
    const { name, latest, description, check_url, changelog, migration_tips } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'El nombre de la aplicación es obligatorio.' });
    }

    const trimmedName = name.trim();

    db.get("SELECT id FROM apps WHERE LOWER(name) = LOWER(?) AND id != ?", [trimmedName, appId], (err, row) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (row) {
            return res.status(400).json({ success: false, error: 'Ya existe otra aplicación con ese nombre.' });
        }

        db.run(`UPDATE apps SET name = ?, latest = ?, description = ?, check_url = ?, changelog = ?, migration_tips = ? WHERE id = ?`,
            [trimmedName, latest, description, check_url, changelog, migration_tips, appId], (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true, message: 'Aplicación actualizada correctamente.' });
            });
    });
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