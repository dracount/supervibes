"use strict";

const { EventEmitter } = require("events");
const WebSocket = require("ws");

/**
 * WsServer — WebSocket server for bidirectional dashboard communication.
 *
 * Attaches to an existing HTTP server at path '/ws'.
 * Replaces SSE for streaming events and adds client-to-server commands.
 *
 * Events emitted:
 *   'clientConnected' (ws)        — new client connected, send init data
 *   'clientMessage'   (ws, msg)   — parsed JSON message from client
 */
class WsServer extends EventEmitter {
  constructor(httpServer) {
    super();
    this._clients = new Set();
    this.wss = new WebSocket.Server({ server: httpServer, path: "/ws" });
    this.wss.on("connection", (ws) => this._onConnect(ws));

    // Ping/pong keepalive every 30s
    this._pingInterval = setInterval(() => {
      for (const ws of this._clients) {
        if (ws.isAlive === false) {
          this._clients.delete(ws);
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);

    this.wss.on("close", () => {
      clearInterval(this._pingInterval);
    });
  }

  /**
   * Broadcast an event to all connected clients.
   */
  broadcast(event, data) {
    const msg = JSON.stringify({ event, data });
    for (const ws of this._clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  /**
   * Send an event to a specific client.
   */
  sendTo(ws, event, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  /**
   * Number of connected clients.
   */
  get clientCount() {
    return this._clients.size;
  }

  /**
   * Gracefully close the WebSocket server.
   */
  close() {
    clearInterval(this._pingInterval);
    for (const ws of this._clients) {
      ws.close(1001, "Server shutting down");
    }
    this._clients.clear();
    this.wss.close();
  }

  // --- Internal ---

  _onConnect(ws) {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    this._clients.add(ws);

    ws.on("close", () => {
      this._clients.delete(ws);
    });

    ws.on("error", () => {
      this._clients.delete(ws);
    });

    ws.on("message", (raw) => this._onMessage(ws, raw));

    this.emit("clientConnected", ws);
  }

  _onMessage(ws, raw) {
    try {
      const msg = JSON.parse(raw.toString());
      this.emit("clientMessage", ws, msg);
    } catch (_) {
      // Ignore malformed messages
    }
  }
}

module.exports = { WsServer };
