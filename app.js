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
const { connected } = require("node:process");

const users = new Map();

async function main() {
  const db = await open({
    filename: "chat.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS chats(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT,
      client_offset TEXT UNIQUE,
      content TEXT,
      nickname TEXT
    );
  `);

  io.on("connection", async (socket) => {
    //db.run("DELETE FROM chats;");
    socket.on("join room", (nickname, room) => {
      socket.nickname = nickname || "Anonymous";

      socket.room = room || "general";
      socket.join(socket.room);

      users.set(socket.id, {
        nickname: socket.nickname,
        room: socket.room,
        connected: true,
      });

      const onlineUsers = Array.from(users.values())
        .filter((u) => u.connected && u.room === room)
        .map((u) => u.nickname);

      io.to(room).emit("Online users", onlineUsers);
      socket.broadcast.to(room).emit("user connected", nickname);
    });

    socket.on("chat message", async (msg, clientOffset, nickname) => {
      if (!socket.room) return;

      const sql =
        "INSERT INTO chats (content, client_offset, nickname, room) VALUES(?, ?, ?, ?)";

      try {
        let result = await db.run(sql, [
          msg,
          clientOffset,
          nickname,
          socket.room,
        ]);
        if (result.changes > 0) {
          io.to(socket.room).emit("chat message", msg, result.lastID, nickname);
        }
      } catch (e) {
        if (e.errno === 19) {
          console.log(e);
        } else {
          console.log(`DB err: ${e.message}`);
          return;
        }
      }
    });

    socket.on("typing", () => {
      socket.broadcast.to(socket.room).emit("user typing", socket.nickname);
    });

    socket.on("stop typing", () => {
      if (socket.room) {
        socket.broadcast
          .to(socket.room)
          .emit("user stop typing", socket.nickname);
      }
    });

    if (!socket.recovered && socket.room) {
      const chats = await db.all(
        `SELECT id, content, nickname FROM chats WHERE room = ? AND id > ? ORDER BY id ASC`,
        [socket.room, socket.handshake.auth.serverOffset || 0]
      );

      chats.forEach((chat) => {
        socket.emit("chat message", chat.content, chat.id, chat.nickname);
      });

      socket.recovered = true;
    }

    socket.on("disconnect", () => {
      // users.delete(socket.id);
      // io.emit("Online users", Array.from(users.values()));
      // socket.broadcast.emit("user disconnected", socket.nickname);

      const user = users.get(socket.id);
      if (user) {
        user.connected = false;
      }

      if (socket.room) {
        const onlineUsers = Array.from(users.values())
          .filter((u) => u.connected && u.room === socket.room)
          .map((u) => u.nickname);

        io.to(socket.room).emit("Online users", onlineUsers);

        socket.broadcast
          .to(socket.room)
          .emit("user disconnected", socket.nickname);
      }
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
