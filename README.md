# Version Hub

Sistema de control y monitoreo de versiones de aplicaciones por provincia/sucursal. El proyecto combina un backend en Node.js + Express, una base de datos SQLite persistente y un dashboard web para visualizar el estado real de cada aplicación en cada región.

## ¿Qué hace?

- Centraliza la versión actual de cada aplicación por provincia.
- Permite administrar provincias y aplicaciones desde una interfaz web.
- Muestra una matriz de versiones con estado visual:
  - Verde: actualizado
  - Amarillo: adelantado / beta
  - Gris: no aplica
  - Rojo: desactualizado
- Soporta sincronización de versiones desde URLs JSON o endpoints remotos.
- Genera un reporte PDF quincenal para el administrador.
- Envía por email el reporte si se configura SMTP.
- Persiste la información en SQLite para que el dashboard siga funcionando sin un servicio externo.

## Stack tecnológico

- Node.js
- Express
- SQLite3
- PDFKit
- Nodemailer
- node-cron
- Tailwind CSS + Alpine.js en el frontend

## Requisitos previos

- Node.js 18 o superior
- npm
- Opcional: Docker y Docker Compose

## Instalación

1. Cloná el repositorio:
   ```bash
   git clone <url-del-repo>
   cd tablero-servicios
   ```

2. Instalá las dependencias:
   ```bash
   npm install
   ```

3. Creá la base de datos y ejecutá la app:
   ```bash
   npm start
   ```

La aplicación quedará disponible en:

```bash
http://localhost:3000
```

## Variables de entorno

El proyecto usa estas variables de entorno para configurar la app y la autenticación:

```bash
PORT=3000
NODE_ENV=production
API_KEY=tu-api-key-admin
VIEWER_KEY=tu-api-key-lectura
SMTP_HOST=smtp.tu-email.com
SMTP_PORT=465
SMTP_USER=usuario@dominio.com
SMTP_PASS=contraseña
```

Valores por defecto si no se definen:

```bash
API_KEY=version-hub-secret-2026
VIEWER_KEY=lectura2026
SMTP_HOST=mail.weit.com.ar
SMTP_PORT=465
```

> `API_KEY` corresponde al perfil administrador y `VIEWER_KEY` al acceso de solo lectura.
> Esto queda reflejado en `.env.example` del proyecto.

## Ejecutar con Docker

El repositorio incluye un `docker-compose.yml` para levantar la app y un servicio `nginx` de prueba.

### Levantar el entorno:

```bash
docker compose up --build -d
```

### Ver logs:

```bash
docker compose logs -f
```

### Detener el entorno:

```bash
docker compose down
```

> En algunos entornos puede ser necesario crear o adaptar `docker-compose.yml` a partir del archivo `docker-compose.temp.yml` y completar los valores reales, especialmente la API key.

## Uso de la app

### Login y roles

La aplicación soporta dos perfiles de acceso desde el mismo login:

| Rol | Credencial | Permisos |
| --- | --- | --- |
| `admin` | `API_KEY` | Accede a toda la administración, edición de apps/provincias, sincronización, configuración y reportes. |
| `viewer` | `VIEWER_KEY` | Solo visualización del estado general y la matriz de versiones. No puede editar ni cambiar configuración. |

Ejemplo de login:

```json
{
  "password": "tu-api-key-admin"
}
```

Cuando se autentica con la clave de administrador, la UI habilita:
- gestión de aplicaciones
- gestión de provincias
- sincronización automática desde URLs externas
- configuración del email del administrador
- envío de reportes

Cuando se autentica con la clave de solo lectura, la UI solo muestra la vista de consulta y bloquea acciones administrativas.

### Panel principal

Desde el dashboard se puede:

- Ver provincias activas
- Ver aplicaciones monitoreadas
- Consultar la matriz de versiones por provincia
- Ver informes de estado general
- En el rol admin: agregar/editar/eliminar provincias
- En el rol admin: agregar/editar/eliminar aplicaciones
- En el rol admin: sincronizar versiones desde URLs externas
- En el rol admin: enviar reporte PDF al administrador
- En el rol admin: configurar email del administrador

### Autenticación y permisos por API

El backend responde con el rol al iniciar sesión:

```json
{
  "success": true,
  "role": "admin",
  "apiKey": "..."
}
```

En el caso de solo lectura, la respuesta es:

```json
{
  "success": true,
  "role": "viewer",
  "apiKey": ""
}
```

La lógica principal del backend está en `server.js` y la validación de permisos se realiza en la UI y en los endpoints administrativos.

## MCP (Model Context Protocol)

El proyecto incluye un servidor MCP para integrar Version Hub con clientes compatibles con MCP, por ejemplo para consultar el estado de versiones o actualizar despliegues desde un agente o herramienta externa.

### Carpeta MCP

```bash
./mcp/
├── index.js
├── package.json
└── node_modules/   # generado al instalar dependencias
```

### Instalación del servidor MCP

```bash
cd mcp
npm install
npm link

Esto creará el comando global version-hub-mcp apuntando siempre a este repositorio independiente, sin importar dónde lo guardes en el futuro.

```

### Variables de entorno para MCP

El servidor MCP usa estas variables:

```bash
VERSION_HUB_URL=http://localhost:3000
VERSION_HUB_API_KEY=tu-api-key
```

Si la app está corriendo en otra máquina o servidor, seteá la URL remota correspondiente.

### Ejecutar el servidor MCP manualmente

```bash
cd mcp
VERSION_HUB_URL=http://localhost:3000 VERSION_HUB_API_KEY=tu-api-key node index.js
```

También podés usar el binario definido en el paquete:

```bash
cd mcp
VERSION_HUB_URL=http://localhost:3000 VERSION_HUB_API_KEY=tu-api-key npx version-hub-mcp
```

### Configuración en un cliente MCP

Ejemplo de configuración para un cliente que soporte `mcpServers`:

```json
{
  "mcpServers": {
    "type": "local",
      "command": [
        "version-hub-mcp"
       ],
       "enabled": true,
       "environment": {
         "VERSION_HUB_URL": "http://localhost:3000",
         "VERSION_HUB_API_KEY": "tu-api-key"
      }
    }
  }

```

### Herramientas disponibles

El servidor MCP expone dos herramientas:

- `get_version_matrix`: devuelve el estado completo de la base de datos del tablero.
- `update_deployment_version`: actualiza la versión de una app en una provincia específica.

Ejemplo de uso conceptual:

```json
{
  "name": "update_deployment_version",
  "arguments": {
    "appId": "app-rancher",
    "branchId": "salta",
    "version": "v2.1.0"
  }
}
```

## API REST

La API expone endpoints básicos para gestionar el estado del sistema.

### Autenticación

La mayoría de los endpoints requieren la cabecera:

```http
x-api-key: <API_KEY>
```

### Endpoints principales

#### Login
```http
POST /api/login
```
Body:
```json
{
  "password": "tu-api-key"
}
```

#### Estado general
```http
GET /api/state
```

#### Configuración del email administrador
```http
POST /api/settings
```
Body:
```json
{
  "admin_email": "admin@ejemplo.com"
}
```

#### Agregar/actualizar despliegue
```http
POST /api/deployments
```
Body:
```json
{
  "appId": "app-rancher",
  "branchId": "salta",
  "version": "v2.1.0",
  "version_url": "https://ejemplo.com/version.json"
}
```

#### Agregar provincia
```http
POST /api/branches
```
Body:
```json
{
  "name": "Salta",
  "contactEmail": "contacto@salta.gob.ar"
}
```

#### Eliminar provincia
```http
DELETE /api/branches/:id
```

#### Agregar aplicación
```http
POST /api/apps
```
Body:
```json
{
  "name": "Rancher",
  "latest": "v1.0.0",
  "description": "Version 2025",
  "check_url": "https://ejemplo.com/latest.json"
}
```

#### Actualizar aplicación
```http
PUT /api/apps/:id
```

#### Eliminar aplicación
```http
DELETE /api/apps/:id
```

#### Verificación de versiones
```http
POST /api/apps/check-updates
POST /api/deployments/check-updates
```

#### Enviar reporte manual
```http
POST /api/reports/send
```

## Persistencia y base de datos

La aplicación crea y usa una base SQLite en:

```bash
./data/database.sqlite
```

Si la base no existe, se crea automáticamente al arrancar el servidor.

## Estructura del proyecto

```text
.
├── public/
│   ├── index.html
│   └── oldindex.html
├── test/
│   └── app.test.js
├── data/
│   └── database.sqlite (se crea automáticamente)
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── docker-compose.temp.yml
├── package.json
├── server.js
├── version.json
└── README.md
```

## Notas importantes

- El tablero está pensado para uso interno / operativa.
- La autenticación se basa en una API Key compartida; en producción conviene usar secretos del entorno o un mecanismo más robusto.
- El reporte PDF se genera con el contenido actual de provincias, apps y despliegues.
- Los emails de administrador se configuran a través de la base de datos y el endpoint de `settings`.
- El proyecto incluye tests básicos de estructura, pero la lógica principal debe validarse con escenarios reales del dashboard.

## Scripts disponibles

```bash
npm start
npm test
```

## Sugerencia de uso recomendado

1. Definir `API_KEY` en variables de entorno.
2. Levantar la app localmente.
3. Ingresar al dashboard.
4. Registrar provincias y aplicaciones.
5. Cargar versiones por cada provincia.
6. Configurar el email del administrador.
7. Dejar el cron para reportes quincenales activo.

## Licencia

Este proyecto no define una licencia específica en el repositorio. Revisá la política del equipo o del cliente antes de reutilizarlo en producción.

.