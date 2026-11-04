import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import cors from 'cors';

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send({
    message: 'Server is running',
    database: databaseReady ? 'connected' : 'disconnected',
  });
});