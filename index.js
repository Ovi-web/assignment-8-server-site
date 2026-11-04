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

app.get('/books', async (req, res) => {
  const filter = req.query.email ? { userEmail: req.query.email } : {};
  res.send(await books.find(filter).toArray());
});

app.get('/books/:id', async (req, res) => {
  const id = getId(req.params.id);
  if (!id) return res.status(400).send({ message: 'Invalid book ID' });

  const book = await books.findOne({ _id: id });
  if (!book) return res.status(404).send({ message: 'Book not found' });
  res.send(book);
});

app.post('/add-books', async (req, res) => {
  if (typeof req.body.userEmail !== 'string' || !req.body.userEmail.trim()) {
    return res.status(400).send({ message: 'A user email is required to add a book.' });
  }

  if (req.body.totalCopies !== undefined) {
    req.body.totalCopies = Number(req.body.totalCopies);
    if (!Number.isFinite(req.body.totalCopies)) {
      return res.status(400).send({ message: 'totalCopies must be a number' });
    }
  }

  const result = await books.insertOne({
    ...req.body,
    createdAt: req.body.createdAt || new Date(),
  });
  res.status(201).send(result);
});

app.get('/', (req, res) => {
  res.send({
    message: 'Server is running',
    database: databaseReady ? 'connected' : 'disconnected',
  });
});