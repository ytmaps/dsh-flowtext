import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
function safeScope(value) {
    return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}
function defaultCredentialPath(scope, namespace = 'dsh-flowtext') {
    const dshHome = process.env.DSH_HOME?.trim();
    const root = dshHome ? resolve(dshHome) : join(homedir(), '.dsh');
    return scope
        ? join(root, 'credentials', namespace, `${safeScope(scope)}.json`)
        : join(root, 'credentials', `${namespace}.json`);
}
function validToken(value) {
    return typeof value === 'string' && value.length >= 24 && value.length <= 4096;
}
/** Mode-0600 local credential file, separate from profile configuration and repositories. */
export class FileCredentialStore {
    path;
    scope;
    legacyPath;
    constructor(path, scope) {
        this.scope = scope;
        this.legacyPath = path === undefined ? resolve(defaultCredentialPath(scope, 'dsh-subagent-flowtext')) : undefined;
        if (path && scope) {
            const base = resolve(path);
            const extension = extname(base) || '.json';
            const stem = basename(base, extension);
            this.path = join(dirname(base), `${stem}.${safeScope(scope)}${extension}`);
        }
        else {
            this.path = resolve(path ?? defaultCredentialPath(scope));
        }
    }
    async load(baseUrl) {
        const current = await this.readMatching(this.path, baseUrl);
        if (current !== undefined)
            return current;
        if (this.legacyPath === undefined)
            return undefined;
        const legacy = await this.readMatching(this.legacyPath, baseUrl);
        if (legacy !== undefined)
            await this.save(baseUrl, legacy).catch(() => undefined);
        return legacy;
    }
    async readMatching(path, baseUrl) {
        try {
            const value = JSON.parse(await readFile(path, 'utf8'));
            return value.version === 1
                && (this.scope !== undefined || value.baseUrl === baseUrl)
                && validToken(value.token)
                ? value.token
                : undefined;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return undefined;
            return undefined;
        }
    }
    async save(baseUrl, token) {
        if (!validToken(token))
            throw new Error('dsh-flowtext: paired token is invalid');
        const directory = dirname(this.path);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        const payload = { version: 1, baseUrl, token };
        try {
            await writeFile(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            await rename(temporary, this.path);
            await chmod(this.path, 0o600);
        }
        catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
        }
    }
    async clear(baseUrl) {
        const paths = [this.path, ...(this.legacyPath === undefined ? [] : [this.legacyPath])];
        for (const path of paths) {
            if (await this.readMatching(path, baseUrl) === undefined)
                continue;
            await unlink(path).catch((error) => {
                if (error.code !== 'ENOENT')
                    throw error;
            });
        }
    }
}
//# sourceMappingURL=credentials.js.map