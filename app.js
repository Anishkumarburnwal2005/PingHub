const express = require("express");
const app = express();

const { join } = require("node:path");
app.use(express.static(__dirname));

const { Server } = require("socket.io");
const { createServer } = require("http");
const server = createServer(app);
const io = new Server(server, {
  connectionStateRecovery: {},
});

const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

async function main() {
  const db = await open({
    filename: "chat.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT
    );
  `);

  io.on("connection", async (socket) => {
    console.log("A user is connected");

    socket.on("chat message", async (msg) => {
      const sql = "INSERT INTO messages (content) VALUES(?)";

      let result;
      try {
        result = await db.run(sql, [msg]);
      } catch (e) {
        return;
      }
      io.emit("chat message", msg, result.lastID);
    });

    if (!socket.recovered) {
      await db.each(
        `SELECT id, content FROM messages WHERE id > ?`,
        [socket.handshake.auth.serverOffset || 0],
        (err, row) => socket.emit("chat message", row.content, row.id)
      );
    }

    socket.on("disconnect", () => {
      console.log("A user is disconnected");
    });
  });
}

main();

app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

server.listen(8080, () => {
  console.log("Server was listing on port 8080");
});
