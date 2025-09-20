// server.js (UPDATED: parentPhone, CSV upload, send-alert via Twilio)
require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const multer = require("multer");
const csv = require("csv-parser");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// Twilio (optional)
let twilioClient = null;
const TW_SID = process.env.TWILIO_ACCOUNT_SID;
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TW_FROM = process.env.TWILIO_FROM;
if (TW_SID && TW_TOKEN && TW_FROM) {
  const twilio = require("twilio");
  twilioClient = twilio(TW_SID, TW_TOKEN);
  console.log("Twilio configured.");
} else {
  console.log("Twilio not configured: SMS will be logged instead of sent.");
}

// ensure uploads folder exists
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// multer setup
const upload = multer({ dest: UPLOAD_DIR });

// --- Database (sqlite) ---
const db = new sqlite3.Database("./database.db");
db.serialize(() => {
  // create tables (make students include parentPhone)
  db.run(`CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    name TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    name TEXT,
    class TEXT,
    parentPhone TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS drills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    class TEXT,
    message TEXT,
    startedBy TEXT,
    startedAt TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drillId INTEGER,
    studentId INTEGER,
    time TEXT
  )`);
});

// --- Socket.io ---
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  socket.on("join", (data) => {
    if (!data) return;
    if (data.class) socket.join(`class:${data.class}`);
    if (data.role) socket.join(`role:${data.role}`);
    console.log("socket join", data);
  });
});

// --- Routes ---

// login (unchanged)
app.post("/login", (req, res) => {
  const { role, username, password } = req.body;
  const table = role === "teacher" ? "teachers" : "students";
  db.get(`SELECT * FROM ${table} WHERE username = ?`, [username], (err, row) => {
    if (err) return res.json({ success: false, message: "DB error" });
    if (!row) return res.json({ success: false, message: "User not found" });
    const ok = bcrypt.compareSync(password, row.password);
    if (!ok) return res.json({ success: false, message: "Wrong password" });
    res.json({
      success: true,
      user: {
        id: row.id,
        username: row.username,
        name: row.name || row.username,
        class: row.class,
        role,
      },
    });
  });
});

// register teacher (unchanged)
app.post("/register-teacher", (req, res) => {
  const { username, password, name } = req.body;
  const hashed = bcrypt.hashSync(password, 8);
  db.run("INSERT INTO teachers (username,password,name) VALUES (?,?,?)", [username, hashed, name], function (err) {
    if (err) return res.json({ success: false, message: "Teacher already exists" });
    res.json({ success: true, id: this.lastID });
  });
});

// add single student (now accepts parentPhone)
app.post("/add-student", (req, res) => {
  const { username, password, name, class: cls, parentPhone } = req.body;
  if (!username || !password) return res.json({ success: false, message: "username/password required" });
  const hashed = bcrypt.hashSync(password, 8);
  db.run(
    "INSERT INTO students (username,password,name,class,parentPhone) VALUES (?,?,?,?,?)",
    [username, hashed, name || username, cls || "ClassA", parentPhone || null],
    function (err) {
      if (err) return res.json({ success: false, message: "Student exists" });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// BULK upload students via CSV
// CSV expected columns: USN,Name,DOB,Class,ParentPhone
app.post("/upload-students", upload.single("file"), (req, res) => {
  if (!req.file) return res.json({ success: false, message: "No file uploaded" });
  const results = [];
  const filePath = req.file.path;
  fs.createReadStream(filePath)
    .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
    .on("data", (data) => results.push(data))
    .on("end", () => {
      let inserted = 0;
      const errors = [];
      // process sequentially to avoid DB locks
      const insertNext = (i) => {
        if (i >= results.length) {
          // cleanup file
          fs.unlinkSync(filePath);
          return res.json({ success: true, inserted, errors });
        }
        const row = results[i];
        // normalize keys (some CSVs may have different header cases)
        const usn = row.USN || row.usn || row.Username || row.username;
        const name = row.Name || row.name;
        const dob = row.DOB || row.dob || row.DOB || row.DOB;
        const cls = row.Class || row.class || row.CLASS || "ClassA";
        const parentPhone = row.ParentPhone || row.parentPhone || row.parent || "";
        if (!usn || !dob) {
          errors.push({ row: i + 1, reason: "Missing USN or DOB" });
          return insertNext(i + 1);
        }
        const hashed = bcrypt.hashSync(dob, 8);
        db.run(
          "INSERT INTO students (username,password,name,class,parentPhone) VALUES (?,?,?,?,?)",
          [usn, hashed, name || usn, cls || "ClassA", parentPhone || null],
          function (err) {
            if (err) errors.push({ row: i + 1, reason: err.message });
            else inserted++;
            insertNext(i + 1);
          }
        );
      };
      insertNext(0);
    });
});

// send alert to parents of a class (and emit socket to class)
// body: { type, class: cls, message, startedBy }
app.post("/send-alert", async (req, res) => {
  const { type, class: cls, message, startedBy } = req.body;
  if (!cls || !type) return res.json({ success: false, message: "type and class required" });

  // Insert alert record into drills table for record keeping (optional)
  const startedAt = new Date().toISOString();
  db.run("INSERT INTO drills (type,class,message,startedBy,startedAt) VALUES (?,?,?,?,?)",
    [type, cls, message, startedBy, startedAt],
    function (err) {
      if (err) console.error("drill insert error", err);
      const alertRecord = { id: this ? this.lastID : null, type, class: cls, message, startedBy, startedAt };

      // query parents in that class
      db.all("SELECT id, username, name, parentPhone FROM students WHERE class = ?", [cls], async (err2, rows) => {
        if (err2) return res.json({ success: false, message: "DB error" });

        const sendPromises = rows.map((r) => {
          const to = r.parentPhone;
          const body = `${type} Alert: ${message || ''} — Your child's school: ${startedBy || 'School'}. Please remain calm.`;
          if (twilioClient && to) {
            return twilioClient.messages.create({ body, from: TW_FROM, to }).then(() => ({ ok: true, to })).catch(e => ({ ok: false, to, error: e.message }));
          } else {
            // Twilio not configured or missing phone - log and resolve
            console.log(`[ALERT LOG] Would send to ${to} : ${body}`);
            return Promise.resolve({ ok: !!to, to, simulated: true });
          }
        });

        const results = await Promise.all(sendPromises);
        // emit socket to class room so any connected student UI (if present) can show alert
        io.to(`class:${cls}`).emit("alert", alertRecord);
        // also emit to role:student (optional)
        io.to("role:student").emit("alert", alertRecord);

        const sent = results.filter(r => r.ok).length;
        const failed = results.length - sent;
        res.json({ success: true, total: results.length, sent, failed, details: results });
      });
    });
});

// mark-safe (unchanged)
app.post("/mark-safe", (req, res) => {
  const { drillId, studentId } = req.body;
  const time = new Date().toISOString();
  db.run("INSERT INTO responses (drillId,studentId,time) VALUES (?,?,?)", [drillId, studentId, time], function (err) {
    if (err) return res.json({ success: false, message: "DB error" });
    io.emit("studentResponded", { drillId, studentId, time });
    res.json({ success: true });
  });
});

// responses & reports (unchanged)
app.get("/responses/:drillId", (req, res) => {
  db.all(`SELECT r.*, s.username, s.name, s.class FROM responses r JOIN students s ON r.studentId = s.id WHERE r.drillId = ?`,
    [req.params.drillId], (err, rows) => {
      if (err) return res.json({ success: false, message: "DB error" });
      res.json({ success: true, responses: rows });
    });
});

app.get("/reports", (req, res) => {
  db.all(
    `SELECT d.id as drillId, d.type, d.class, d.startedAt, d.startedBy,
       (SELECT COUNT(*) FROM responses r WHERE r.drillId = d.id) as responsesCount
     FROM drills d ORDER BY d.startedAt DESC`,
    [], (err, rows) => {
      if (err) return res.json({ success: false, message: "DB error" });
      res.json({ success: true, reports: rows });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
