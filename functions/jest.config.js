module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // The money logic is shared with the web app via tsconfig `paths`; jest needs
  // the same alias or every `@/lib/*` import in a Cloud Function fails to resolve.
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/../src/$1' },
};
