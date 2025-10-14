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
const roomSecure = new Map();

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
    socket.on("join room", async (nickname, room, password) => {
      if (!room || !nickname) {
        socket.emit("join error", "Room name or nickname missing!");
        return;
      }

      // Check if room exists
      if (!roomSecure.has(room)) {
        // First user — create new room with password
        if (!password) {
          socket.emit("join error", "Please set a password for this new room.");
          return;
        }

        roomSecure.set(room, password);
        console.log(`Room created: ${room} with password: ${password}`);
      } else {
        // Room already exists — check password
        const existingPassword = roomSecure.get(room);
        if (password !== existingPassword) {
          socket.emit("join error", "Incorrect password for this room!");
          return;
        }
      }

      socket.nickname = nickname;
      socket.room = room;
      socket.join(socket.room);

      users.set(socket.id, {
        nickname: socket.nickname,
        room: socket.room,
        connected: true,
      });

      roomSecure.set(socket.id, password);

      const onlineUsers = Array.from(users.values())
        .filter((u) => u.connected && u.room === room)
        .map((u) => u.nickname);

      io.to(room).emit("Online users", onlineUsers);
      socket.broadcast.to(room).emit("user connected", nickname);

      if (!socket.recovered) {
        const chats = await db.all(
          `SELECT id, content, nickname FROM chats WHERE room = ? AND id > ? ORDER BY id ASC`,
          [socket.room, lastServerOffset]
        );

        chats.forEach((chat) => {
          socket.emit("chat message", chat.content, chat.id, chat.nickname);
        });

        // socket.recovered = true;
      }
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

    const lastServerOffset = socket.handshake.auth.serverOffset || 0;

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
