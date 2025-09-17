import sql, { config as MSSQLConfig, ConnectionPool } from 'mssql';

export type SqlResult = { success: boolean; data?: any[]; error?: string };

class SqlServerService {
  private pool: ConnectionPool | null = null;

  private getConfig(): MSSQLConfig {
    return {
      server: process.env.SQLSERVER_SERVER || 'localhost',
      port: process.env.SQLSERVER_PORT ? Number(process.env.SQLSERVER_PORT) : 1433,
      database: process.env.SQLSERVER_DATABASE || '',
      user: process.env.SQLSERVER_USER || '',
      password: process.env.SQLSERVER_PASSWORD || '',
      options: {
        encrypt: (process.env.SQLSERVER_ENCRYPT || 'true').toLowerCase() === 'true',
        trustServerCertificate: (process.env.SQLSERVER_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() === 'true',
      },
      pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    } as MSSQLConfig;
  }

  private async getPool(): Promise<ConnectionPool> {
    if (this.pool && this.pool.connected) return this.pool;
    const cfg = this.getConfig();
    this.pool = await new sql.ConnectionPool(cfg).connect();
    return this.pool;
  }

  async executeStoredProcedure(spName: string, params?: Record<string, unknown>): Promise<SqlResult> {
    try {
      const pool = await this.getPool();
      const req = pool.request();
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          req.input(key, value as any);
        }
      }
      const res = await req.execute(spName);
      const rows: any[] = [];
      const recordsets = res.recordsets && res.recordsets.length ? res.recordsets : (res.recordset ? [res.recordset] : []);
      for (const rs of recordsets) {
        for (const row of rs) rows.push(row);
      }
      return { success: true, data: rows };
    } catch (e: any) {
      return { success: false, error: String(e?.message || e) };
    }
  }
}

export const sqlServer = new SqlServerService();


