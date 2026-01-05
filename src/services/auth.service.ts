import db from '../config/database';
import crypto from 'crypto';

// User interface
export interface User {
  id: number;
  email: string;
  password_hash: string;
  created_at: string;
}

// Simple password hashing (for production, use bcrypt)
function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Generate a simple JWT-like token (for production, use proper JWT)
function generateToken(userId: number, email: string): string {
  const payload = {
    id: userId,
    email,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  };
  const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha256', 'bet-tracker-secret-key')
    .update(base64Payload)
    .digest('hex');
  return `${base64Payload}.${signature}`;
}

// Verify token
export function verifyToken(token: string): { id: number; email: string } | null {
  try {
    const [base64Payload, signature] = token.split('.');
    const expectedSignature = crypto
      .createHmac('sha256', 'bet-tracker-secret-key')
      .update(base64Payload)
      .digest('hex');

    if (signature !== expectedSignature) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString());
    if (payload.exp < Date.now()) {
      return null;
    }

    return { id: payload.id, email: payload.email };
  } catch {
    return null;
  }
}

class AuthService {
  constructor() {
    this.initializeUsersTable();
  }

  private initializeUsersTable(): void {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

      // Seed default user if not exists
      this.seedDefaultUser();
    } catch (error) {
      console.error('Error initializing users table:', error);
    }
  }

  private seedDefaultUser(): void {
    try {
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get('robert@gmail.com');
      if (!existingUser) {
        const passwordHash = hashPassword('don_quixote');
        db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run('robert@gmail.com', passwordHash);
        console.log('Seed user created: robert@gmail.com');
      } else {
        // Update existing user's password
        const passwordHash = hashPassword('don_quixote');
        db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(passwordHash, 'robert@gmail.com');
      }
    } catch (error) {
      console.error('Error seeding default user:', error);
    }
  }

  signUp(email: string, password: string): { success: boolean; message?: string; user?: Omit<User, 'password_hash'> } {
    try {
      // Check if email already exists
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingUser) {
        return { success: false, message: 'Email already exists' };
      }

      // Hash password and insert user
      const passwordHash = hashPassword(password);
      const result = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, passwordHash);

      const user = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(result.lastInsertRowid) as Omit<User, 'password_hash'>;

      return { success: true, user };
    } catch (error: any) {
      console.error('Error signing up:', error);
      return { success: false, message: error.message };
    }
  }

  login(email: string, password: string): { success: boolean; message?: string; user?: Omit<User, 'password_hash'>; token?: string } {
    try {
      const passwordHash = hashPassword(password);
      const user = db.prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?').get(email) as User | undefined;

      if (!user || user.password_hash !== passwordHash) {
        return { success: false, message: 'Invalid email or password' };
      }

      const token = generateToken(user.id, user.email);

      return {
        success: true,
        user: { id: user.id, email: user.email, created_at: user.created_at },
        token,
      };
    } catch (error: any) {
      console.error('Error logging in:', error);
      return { success: false, message: error.message };
    }
  }

  getUserById(id: number): Omit<User, 'password_hash'> | null {
    try {
      return db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(id) as Omit<User, 'password_hash'> | null;
    } catch {
      return null;
    }
  }
}

export const authService = new AuthService();
export default authService;
