import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

async function migrate() {
    const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
    });

  try {
        const sqlPath = path.join(__dirname, '001_initial.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        console.log('Running migration...');
        await pool.query(sql);
        console.log('Migration completed successfully!');
  } catch (error: any) {
        if (error.code === '42P07') {
                console.log('Tables already exist, skipping migration.');
        } else {
                console.error('Migration failed:', error.message);
                process.exit(1);
        }
  } finally {
        await pool.end();
  }
}

migrate();
