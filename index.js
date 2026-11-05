import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import cors from 'cors';
import { errors, jwtVerify } from 'jose';

const app = express();
const PORT = Number.parseInt(process.env.PORT || '8000', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const authBaseURL = process.env.BETTER_AUTH_URL;
const clientOrigin = new URL(
  process.env.CLIENT_ORIGIN || authBaseURL || `${process.env.CLIENT_URL}`,
).origin;
const jwtSecret = process.env.JWT_SECRET;
const jwtSecretKey = jwtSecret ? new TextEncoder().encode(jwtSecret) : null;
const jwtSecretReady = Boolean(jwtSecretKey && jwtSecretKey.byteLength >= 32);
const jwtIssuer = process.env.JWT_ISSUER;
const jwtAudience = process.env.JWT_AUDIENCE;

app.use(cors({ origin: clientOrigin, credentials: true }));
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

const getJwtFromRequest = (req) => {
  const authorization = req.get('authorization');
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] || null;
};

const requireAuth = async (req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin !== clientOrigin) {
    return res.status(403).send({ message: 'Request origin is not allowed' });
  }

  if (!jwtSecretReady) {
    return res.status(503).send({ message: 'JWT authentication is not configured correctly' });
  }

  const token = getJwtFromRequest(req);
  if (!token) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).send({ message: 'A valid Bearer token is required' });
  }

  try {
    const { payload } = await jwtVerify(token, jwtSecretKey, {
      algorithms: ['HS256'],
      ...(jwtIssuer ? { issuer: jwtIssuer } : {}),
      ...(jwtAudience ? { audience: jwtAudience } : {}),
    });
    const user = payload.user && typeof payload.user === 'object' ? payload.user : payload;
    const userId = payload.sub || user.id || payload.userId;
    if (
      typeof userId !== 'string'
      || typeof user.email !== 'string'
      || (payload.sub && user.id && payload.sub !== user.id)
    ) {
      return res.status(401).send({ message: 'The JWT does not contain a valid user identity' });
    }

    req.authUser = { id: userId, email: user.email };
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      return res.status(401).send({ message: 'The sign-in JWT is invalid or expired' });
    }
    console.error(`JWT verification failed: ${error.message}`);
    return res.status(503).send({ message: 'Unable to verify the sign-in JWT' });
  }

  next();
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

app.patch('/books/:id', requireAuth, async (req, res) => {
  const id = getId(req.params.id);
  if (!id) return res.status(400).send({ message: 'Invalid book ID' });

  const book = await books.findOne({ _id: id });
  if (!book) return res.status(404).send({ message: 'Book not found' });
  if (book.userEmail !== req.authUser.email) {
    return res.status(403).send({ message: 'You can only update your own books' });
  }

  const updates = { ...req.body };
  delete updates._id;
  delete updates.userEmail;
  delete updates.createdAt;
  if (!Object.keys(updates).length) {
    return res.status(400).send({ message: 'No editable book fields were provided' });
  }

  if (updates.totalCopies !== undefined) {
    updates.totalCopies = Number(updates.totalCopies);
    if (!Number.isFinite(updates.totalCopies)) {
      return res.status(400).send({ message: 'totalCopies must be a number' });
    }
  }

  const result = await books.updateOne(
    { _id: id, userEmail: req.authUser.email },
    { $set: updates },
  );
  if (!result.matchedCount) return res.status(404).send({ message: 'Book not found' });
  res.send({ success: true, message: 'Book updated successfully' });
});

app.delete('/books/:id', requireAuth, async (req, res) => {
  const id = getId(req.params.id);
  if (!id) return res.status(400).send({ message: 'Invalid book ID' });

  const book = await books.findOne({ _id: id });
  if (!book) return res.status(404).send({ message: 'Book not found' });
  if (book.userEmail !== req.authUser.email) {
    return res.status(403).send({ message: 'You can only delete your own books' });
  }

  const borrowed = await borrows.findOne({
    bookId: { $in: [req.params.id, id] },
  });
  if (borrowed) return res.status(400).send({ message: 'This book is currently borrowed.' });

  const result = await books.deleteOne({ _id: id, userEmail: req.authUser.email });
  if (!result.deletedCount) return res.status(404).send({ message: 'Book not found' });
  res.send({ success: true, message: 'Book deleted successfully' });
});

app.post('/add-books', requireAuth, async (req, res) => {
  if (req.body.totalCopies !== undefined) {
    req.body.totalCopies = Number(req.body.totalCopies);
    if (!Number.isFinite(req.body.totalCopies)) {
      return res.status(400).send({ message: 'totalCopies must be a number' });
    }
  }

  const result = await books.insertOne({
    ...req.body,
    userEmail: req.authUser.email,
    createdAt: req.body.createdAt || new Date(),
  });
  res.status(201).send(result);
});

app.post('/borrows', requireAuth, async (req, res) => {
  const { bookId } = req.body;
  const userEmail = req.authUser.email;
  const id = getId(bookId);
  if (!id) return res.status(400).send({ message: 'A valid bookId is required' });

  const book = await books.findOne({ _id: id });
  if (!book) return res.status(404).send({ message: 'Book not found' });
  if (book.totalCopies <= 0) return res.status(400).send({ message: 'This book is unavailable' });

  const alreadyBorrowed = await borrows.findOne({ bookId: String(bookId), userEmail });
  if (alreadyBorrowed) return res.status(400).send({ message: 'Already borrowed this book!' });

  const result = await borrows.insertOne({
    ...req.body,
    bookId: String(bookId),
    userEmail,
    createdAt: new Date(),
  });
  await books.updateOne({ _id: id }, { $inc: { totalCopies: -1 } });
  res.status(201).send(result);
});

app.get('/borrows', requireAuth, async (req, res) => {
  res.send(await borrows.find({ userEmail: req.authUser.email }).toArray());
});

app.delete('/borrows/:id', requireAuth, async (req, res) => {
  const id = getId(req.params.id);
  if (!id) return res.status(400).send({ message: 'Invalid borrow ID' });

  const borrow = await borrows.findOne({ _id: id });
  if (!borrow) return res.status(404).send({ message: 'Borrow not found' });
  if (borrow.userEmail !== req.authUser.email) {
    return res.status(403).send({ message: 'You can only remove your own borrows' });
  }

  const result = await borrows.deleteOne({ _id: id, userEmail: req.authUser.email });
  const bookId = getId(borrow.bookId);
  if (bookId) await books.updateOne({ _id: bookId }, { $inc: { totalCopies: 1 } });
  res.send(result);
});

app.get('/', (req, res) => {
  res.send({
    message: 'Server is running',
    database: databaseReady ? 'connected' : 'disconnected',
    authentication: jwtSecretReady ? 'JWT verification configured' : 'JWT secret is missing or too short',
  });
});

app.listen(PORT, () => {
  console.log(`Server is running at ${PORT}`);
  if (!jwtSecret) {
    console.error('JWT_SECRET is missing. Protected routes will return 503 until it is configured.');
  } else if (!jwtSecretReady) {
    console.error('JWT_SECRET must be at least 32 bytes for HS256. Protected routes will return 503.');
  }

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is missing. Add it to the .env file to enable database routes.');
    return;
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  client.connect()
    .then(async () => {
      const db = client.db('booknookserver');
      await Promise.all([
        ensureCollection(db, 'books'),
        ensureCollection(db, 'borrows'),
      ]);
      books = db.collection('books');
      borrows = db.collection('borrows');
      databaseReady = true;
      console.log('Connected to MongoDB');
    })
    .catch((error) => {
      console.error(`MongoDB connection failed: ${error.message}`);
    });
});


export default app;