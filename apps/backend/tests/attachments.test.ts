import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.userPoolId = 'pool-id';
process.env.userPoolClientId = 'client-id';
process.env.awsCognitoRegion = 'us-east-1';
process.env.sessionsTableName = 'sessions-table';
process.env.authUsersTableName = 'auth-users-table';
process.env.authRolesTableName = 'auth-roles-table';
process.env.clusterArn = 'arn:aws:rds::cluster';
process.env.secretArn = 'arn:aws:secret::s';
process.env.databaseName = 'appdb';
process.env.postmarkServerToken = 'fake';
process.env.postmarkFromEmail = 'auth@example.test';
process.env.bucketName = 'fake-bucket';
process.env.s3Prefix = 'test-app';
process.env.AWS_REGION = 'us-east-1';

// ------- Session + auth mocks -------
const sessionsSpies = {
  getSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteUserSessions: vi.fn(),
};
vi.mock('../src/auth/sessions.js', () => ({
  getSession: (...a: unknown[]) => sessionsSpies.getSession(...a),
  createSession: (...a: unknown[]) => sessionsSpies.createSession(...a),
  deleteSession: (...a: unknown[]) => sessionsSpies.deleteSession(...a),
  deleteUserSessions: (...a: unknown[]) =>
    sessionsSpies.deleteUserSessions(...a),
}));

vi.mock('../src/auth/cognito.js', () => ({
  ensureUser: vi.fn(),
  startCustomAuth: vi.fn(),
  respondToCustomChallenge: vi.fn(),
  refreshTokens: vi
    .fn()
    .mockResolvedValue({ accessToken: 'at', expiresIn: 3600 }),
  getCognito: vi.fn(),
}));

vi.mock('../src/auth/users.js', () => ({
  findUserById: vi.fn(),
  findUserByEmail: vi.fn(),
  addAllowlistedUser: vi.fn(),
  listUsers: vi.fn(),
  setSuspended: vi.fn(),
  countActiveAdmins: vi.fn(),
  countUsers: vi.fn(),
  createFirstAdmin: vi.fn(),
  linkCognitoSub: vi.fn(),
  bootstrapComplete: vi.fn(),
}));

vi.mock('../src/auth/permissions.js', () => ({
  PERMISSIONS: {
    USERS_LIST: 'users:list',
    USERS_ADD: 'users:add',
    USERS_SUSPEND: 'users:suspend',
    NEWSLETTER_LIST: 'newsletter:list',
    NOTES_READ_OWN: 'notes:read:own',
    NOTES_WRITE_OWN: 'notes:write:own',
  },
  ALL_PERMISSIONS: [],
  MEMBER_PERMISSIONS: [],
  roleHasPermission: async (roleName: string, perm: string) => {
    if (roleName === 'admin') return true;
    if (roleName === 'member') {
      return perm === 'notes:read:own' || perm === 'notes:write:own';
    }
    return false;
  },
  invalidateRoleCache: () => undefined,
}));

vi.mock('../src/email/postmark.js', () => ({ sendOtp: vi.fn() }));

// ------- S3 + presigner mocks -------

const s3Send = vi.fn().mockResolvedValue({});
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(cmd: unknown): Promise<unknown> {
      return s3Send(cmd);
    }
  }
  class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class GetObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class DeleteObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
});

const presigner = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => presigner(...args),
}));

// ------- Drizzle / DB mock -------
//
// Every SELECT chain (regardless of where/limit/orderBy shape) shifts
// the next batch of rows off `db.selectQueue`. Tests enqueue the rows
// they expect each select call (in order) to return.
//
// INSERT uses a dedicated single-value `db.insertRows`. DELETE just
// counts invocations.

const db = {
  selectQueue: [] as unknown[][],
  insertRows: [] as unknown[],
  deleteCalls: 0,
};

vi.mock('../src/db/resilience.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/db/resilience.js')
  >('../src/db/resilience.js');
  return { ...actual, warmupCluster: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../src/db/client.js', () => {
  // Drizzle's where() can either be awaited directly OR chained with
  // .limit() / .orderBy(). All three terminal forms refer to the SAME
  // logical query, so we shift the queue only ONCE per where() call,
  // lazily — whichever terminal form runs first wins, and the others
  // return the cached promise.
  const buildAwaitableQuery = () => {
    let cached: Promise<unknown[]> | null = null;
    const resolve = () => {
      if (!cached) {
        cached = Promise.resolve(db.selectQueue.shift() ?? []);
      }
      return cached;
    };
    return {
      limit: resolve,
      orderBy: resolve,
      then: (
        onF: (rows: unknown[]) => unknown,
        onR?: (reason: unknown) => unknown,
      ) => resolve().then(onF, onR),
      catch: (onR: (reason: unknown) => unknown) => resolve().catch(onR),
      finally: (onF: () => void) => resolve().finally(onF),
    };
  };
  const selectChain = () => ({
    from: () => ({
      where: buildAwaitableQuery,
      // ORDER BY without a WHERE — also an independent terminal form.
      orderBy: () => Promise.resolve(db.selectQueue.shift() ?? []),
    }),
  });
  return {
    getDb: () => ({
      select: () => selectChain(),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve(db.insertRows),
        }),
      }),
      delete: () => ({
        where: () => {
          db.deleteCalls += 1;
          return Promise.resolve();
        },
      }),
    }),
  };
});

vi.mock('../src/db/schema.js', () => ({
  users: {},
  notes: { id: 'id', userId: 'user_id' },
  noteAttachments: {
    id: 'id',
    noteId: 'note_id',
    userId: 'user_id',
    s3Key: 's3_key',
    createdAt: 'created_at',
  },
  newsletterSubscriptions: {},
}));

function asMember() {
  sessionsSpies.getSession.mockResolvedValue({
    sessionId: 'sid',
    userId: 'u-member',
    email: 'member@example.test',
    roleName: 'member',
    refreshToken: 'rt',
  });
}

function cookie() {
  return { cookie: 'hereya_sid=sid' };
}

const ownedNote = [{ id: 'n1', userId: 'u-member' }];

import { app } from '../src/app.js';

describe('note attachments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    s3Send.mockReset();
    s3Send.mockResolvedValue({});
    presigner.mockReset();
    presigner.mockResolvedValue('https://signed.example/aws-url');
    sessionsSpies.getSession.mockReset();
    db.selectQueue = [];
    db.insertRows = [];
    db.deleteCalls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /api/notes/:id/attachments → 404 when the note does not belong to the caller', async () => {
    asMember();
    db.selectQueue = [[]]; // findOwnedNote → no rows

    const res = await app.request('/api/notes/n1/attachments', {
      headers: cookie(),
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/notes/:id/attachments returns the rows with a presigned downloadUrl each', async () => {
    asMember();
    db.selectQueue = [
      ownedNote,
      [
        {
          id: 'a1',
          filename: 'one.txt',
          contentType: 'text/plain',
          sizeBytes: 10,
          createdAt: new Date('2025-01-01'),
          s3Key: 'notes/n1/a1/one.txt',
        },
      ],
    ];

    const res = await app.request('/api/notes/n1/attachments', {
      headers: cookie(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]?.filename).toBe('one.txt');
    expect(body[0]?.downloadUrl).toBe('https://signed.example/aws-url');
    expect(presigner).toHaveBeenCalledTimes(1);
  });

  it('POST /api/notes/:id/attachments/upload-url returns 400 on missing fields', async () => {
    asMember();
    db.selectQueue = [ownedNote]; // findOwnedNote passes

    const res = await app.request('/api/notes/n1/attachments/upload-url', {
      method: 'POST',
      headers: { ...cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/notes/:id/attachments/upload-url rejects files > 25 MB', async () => {
    asMember();
    db.selectQueue = [ownedNote];

    const res = await app.request('/api/notes/n1/attachments/upload-url', {
      method: 'POST',
      headers: { ...cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'huge.bin',
        contentType: 'application/octet-stream',
        sizeBytes: 26 * 1024 * 1024, // 26 MB
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/notes/:id/attachments/upload-url inserts a row and returns a presigned PUT URL', async () => {
    asMember();
    db.selectQueue = [ownedNote];
    db.insertRows = [
      {
        id: 'a-new',
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1234,
        createdAt: new Date('2025-01-01'),
        s3Key: 'notes/n1/a-new/photo.jpg',
      },
    ];

    const res = await app.request('/api/notes/n1/attachments/upload-url', {
      method: 'POST',
      headers: { ...cookie(), 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1234,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.uploadUrl).toBe('https://signed.example/aws-url');
    expect(body.filename).toBe('photo.jpg');
    expect(presigner).toHaveBeenCalledTimes(1);
  });

  it('DELETE /api/notes/:id/attachments/:attId removes the row and the S3 object', async () => {
    asMember();
    db.selectQueue = [
      ownedNote, // findOwnedNote
      [{ s3Key: 'notes/n1/a-existing/file.txt' }], // attachment lookup
    ];

    const res = await app.request('/api/notes/n1/attachments/a-existing', {
      method: 'DELETE',
      headers: cookie(),
    });
    expect(res.status).toBe(200);
    expect(db.deleteCalls).toBeGreaterThanOrEqual(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
  });
});
