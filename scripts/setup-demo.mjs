import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { seedDemoSource } from './seed-demo-source.mjs';

if (!existsSync('.env.local')) {
  const example = readFileSync('.env.example', 'utf8')
    .replace(/^NEXTAUTH_SECRET=$/m, `NEXTAUTH_SECRET=${randomBytes(32).toString('hex')}`)
    .replace(/^DEMO_ADMIN_PASSWORD=$/m, `DEMO_ADMIN_PASSWORD=${randomBytes(18).toString('base64url')}`)
    .replace(/^PERSONALIZATION_CONTEXT_SECRET=$/m, `PERSONALIZATION_CONTEXT_SECRET=${randomBytes(32).toString('hex')}`);
  writeFileSync('.env.local', example, { flag: 'wx', mode: 0o600 });
  console.log('로컬 설정을 생성했습니다.');
}
seedDemoSource();
console.log('가상 상품 DB가 준비되었습니다. 로그인 비밀번호는 .env.local의 DEMO_ADMIN_PASSWORD에서 확인하세요.');
