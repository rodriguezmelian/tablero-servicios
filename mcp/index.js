#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Apunta directamente a tu servidor público en Ubuntu
const BASE_URL = process.env.VERSION_HUB_URL || "http://CAMBIAR";
const API_KEY = process.env.VERSION_HUB_API_KEY || "CAMBIAR";

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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_version_matrix",
        description: "Obtiene el estado completo de aplicaciones, provincias y despliegues de Version Hub.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "update_deployment_version",
        description: "Actualiza la versión de una aplicación en una provincia específica.",
        inputSchema: {
          type: "object",
          properties: {
            appId: { type: "string", description: "ID o nombre de la aplicación (ej. app-rancher)" },
            branchId: { type: "string", description: "ID o nombre de la provincia (ej. salta, cordoba)" },
            version: { type: "string", description: "Nueva versión instalada (ej. v1.2.0 o N/A)" }
          },
          required: ["appId", "branchId", "version"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_version_matrix") {
    try {
      const response = await fetch(`${BASE_URL}/api/state`);
      if (!response.ok) throw new Error(`Error HTTP: ${response.status}`);
      const data = await response.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error al conectar: ${error.message}` }], isError: true };
    }
  }

  if (name === "update_deployment_version") {
    const { appId, branchId, version } = args;
    try {
      const response = await fetch(`${BASE_URL}/api/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ appId, branchId, version }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Error HTTP: ${response.status}`);

      return { content: [{ type: "text", text: `Actualizado con éxito: ${appId} en ${branchId} -> ${version}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error al actualizar: ${error.message}` }], isError: true };
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