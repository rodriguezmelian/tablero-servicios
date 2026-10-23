#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// URL pública de tu Version Hub y API Key
const BASE_URL = process.env.VERSION_HUB_URL || "http://52.149.228.132:3000";
const API_KEY = process.env.VERSION_HUB_API_KEY || "version-hub-secret-2026"; // Reemplaza si cambiaste tu clave

const server = new Server(
  {
    name: "version-hub-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Definir las herramientas (Tools) disponibles para la IA
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_version_matrix",
        description: "Obtiene el estado completo de aplicaciones, provincias y despliegues consultando la API pública de Version Hub.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "update_deployment_version",
        description: "Actualiza la versión de una aplicación en una provincia específica mediante la API REST de Version Hub.",
        inputSchema: {
          type: "object",
          properties: {
            appId: { type: "string", description: "ID o nombre de la aplicación (ej. app-rancher o Postgres)" },
            branchId: { type: "string", description: "ID o nombre de la provincia (ej. salta, cordoba)" },
            version: { type: "string", description: "Nueva versión instalada (ej. v1.2.0 o N/A)" }
          },
          required: ["appId", "branchId", "version"],
        },
      },
    ],
  };
});

// Manejar la ejecución de las herramientas cuando la IA las invoque
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_version_matrix") {
    try {
      const response = await fetch(`${BASE_URL}/api/state`);
      if (!response.ok) throw new Error(`Error HTTP: ${response.status}`);
      const data = await response.json();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error al conectar con la API de Version Hub: ${error.message}` }],
        isError: true,
      };
    }
  }

  if (name === "update_deployment_version") {
    const { appId, branchId, version } = args;
    try {
      const response = await fetch(`${BASE_URL}/api/deployments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
        },
        body: JSON.stringify({ appId, branchId, version }),
      });
      
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Error HTTP: ${response.status}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Despliegue actualizado con éxito vía API: ${appId} en ${branchId} -> ${version}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error al actualizar mediante la API: ${error.message}` }],
        isError: true,
      };
    }
  }

  throw new Error(`Herramienta desconocida: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Error en el servidor MCP:", error);
  process.exit(1);
});