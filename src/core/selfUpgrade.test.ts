import { performSelfUpgrade } from './selfUpgrade';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

jest.mock('child_process');
jest.mock('fs');

const mockExecSync = execSync as jest.Mock;
const mockExistsSync = existsSync as jest.Mock;
const mockReadFileSync = readFileSync as jest.Mock;
const mockWriteFileSync = writeFileSync as jest.Mock;

const packageJsonPath = join(process.cwd(), 'package.json');
const mockPackageJson = {
  dependencies: {
    '@openclaw/core': '1.0.0'
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(JSON.stringify(mockPackageJson));
  mockExecSync.mockReturnValue('1.0.1');
});

test('should return up-to-date message when versions match', async () => {
  mockExecSync.mockReturnValue('1.0.0');
  const result = await performSelfUpgrade();
  expect(result).toContain('Already up to date');
});

test('should return dry-run message when dryRun is true', async () => {
  const result = await performSelfUpgrade({ dryRun: true });
  expect(result).toContain('Would upgrade');
});

test('should upgrade when versions differ', async () => {
  const result = await performSelfUpgrade();
  expect(result).toContain('Successfully upgraded');
  expect(mockWriteFileSync).toHaveBeenCalledWith(
    packageJsonPath,
    expect.stringContaining('1.0.1')
  );
});

test('should return clear error when npm registry lookup fails', async () => {
  mockExecSync.mockImplementation(() => {
    throw new Error('network unavailable');
  });
  const result = await performSelfUpgrade({ dryRun: true });
  expect(result).toBe('Could not fetch latest @openclaw/core version from npm registry.');
});

test('should return clear error when src/index.ts is missing', async () => {
  mockExistsSync.mockReturnValue(false);
  const result = await performSelfUpgrade();
  expect(result).toBe('Could not perform self-upgrade: src/index.ts was not found.');
});

test('should throw when @openclaw/core is not found', async () => {
  mockReadFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }));
  await expect(performSelfUpgrade()).rejects.toThrow();
});
