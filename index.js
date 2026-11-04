import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import cors from 'cors';

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());

let books;
let borrows;
let databaseReady = false;

app.use((req, res, next) => {
  if (!databaseReady && req.path !== '/') {
    return res.status(503).send({ message: 'Database is not connected yet' });
  }
  next();
});

const getId = (id) => typeof id === 'string' && ObjectId.isValid(id) ? new ObjectId(id) : null;

const ensureCollection = async (db, name) => {
  try {
    await db.createCollection(name);
  } catch (error) {
    if (error.code !== 48) throw error;
  }
};

app.get('/', (req, res) => {
  res.send({
    message: 'Server is running',
    database: databaseReady ? 'connected' : 'disconnected',
  });
});