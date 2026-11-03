import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const upstream = createRequire('/Users/harris/Desktop/ZTools/package.json');
export default {
    root: fileURLToPath(new URL('.', import.meta.url)),
    resolve: { alias: { marked: upstream.resolve('marked') } },
    test: { environment: 'jsdom', include: ['tests/**/*.test.ts'], restoreMocks: true }
};
