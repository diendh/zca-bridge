import { Pool } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 20 }); // room for the parallel workers + webhook/admin traffic
}
