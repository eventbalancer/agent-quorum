import path from 'node:path';

export interface DockerProbeProgramInput {
  readonly hostPort: number;
  readonly commandTimeoutMs: number;
  readonly expectedPnpm: string;
  readonly forbiddenFile: string;
  readonly sourceRoot: string;
}

export function dockerProbeProgram(input: DockerProbeProgramInput): string {
  return `
      const fs = require('node:fs');
      const { pathToFileURL } = require('node:url');
      const net = require('node:net');
      const { spawnSync } = require('node:child_process');
      function deniedRead(file) { try { fs.readFileSync(file); return false; } catch (error) { return ['EACCES','EPERM','ENOENT'].includes(error.code); } }
      function protectedSupervisor() { try { const fd=fs.openSync('/proc/1/fd/0',fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);fs.closeSync(fd);return false; } catch(error) { return ['EACCES','EPERM'].includes(error.code); } }
      function deniedToolWrite() { try { fs.writeFileSync('/aq-toolchain/node_modules/vitest/vitest.mjs', 'invalid'); return false; } catch (error) { return ['EACCES','EPERM','EROFS'].includes(error.code); } }
      function deniedWrite() { try { fs.writeFileSync('/aq-harness/.delivery-confinement-probe', 'invalid'); return false; } catch (error) { return ['EACCES','EPERM','EROFS'].includes(error.code); } }
      function connects(port) { return new Promise(resolve => { const socket=net.createConnection({host:'127.0.0.1',port}); const done=value=>{socket.destroy();resolve(value)};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(500,()=>done(false)); }); }
      (async () => {
        const owned = net.createServer(socket => socket.destroy());
        await new Promise((resolve,reject)=>{owned.once('error',reject);owned.listen(0,'127.0.0.1',resolve)});
        const loopback = await connects(owned.address().port);
        await new Promise(resolve=>owned.close(resolve));
        const hostDenied = !(await connects(${input.hostPort}));
        fs.writeFileSync('owned-write', 'yes');
        const gate = await import(pathToFileURL('/aq-harness/dist/delivery/gate-toolchain.js'));
        gate.assertToolchainSnapshot('/aq-harness','/aq-toolchain');
        const pnpm=spawnSync('pnpm',['--version'],{encoding:'utf8',timeout:5000});
        const install=spawnSync('pnpm',['install','--frozen-lockfile','--offline','--ignore-scripts'],{encoding:'utf8',timeout:${input.commandTimeoutMs},maxBuffer:8*1024*1024});
        const loader=spawnSync(process.execPath,[gate.toolEntrypoint('/aq-toolchain','tsx'),'-e',"import('ajv').then(()=>process.stdout.write('ready'))"],{encoding:'utf8',timeout:5000});
        fs.mkdirSync('tests',{recursive:true});
        fs.rmSync('node_modules/vitest',{recursive:true,force:true});
        fs.mkdirSync('node_modules/vitest',{recursive:true});
        fs.writeFileSync('node_modules/vitest/package.json',JSON.stringify({name:'vitest',type:'module',exports:'./index.js'}));
        fs.writeFileSync('node_modules/vitest/index.js','throw new Error("candidate tool poisoning")');
        const fixture='tests/toolchain.test.ts';
        const check=()=>spawnSync(process.execPath,['/aq-harness/dist/delivery/gate-runner.js','/aq-toolchain','/aq-harness',process.cwd(),'run','test'],{encoding:'utf8',timeout:${input.commandTimeoutMs},maxBuffer:8*1024*1024}).status;
        fs.writeFileSync(fixture,'import {test,expect} from "vitest";test("frozen assertion",()=>expect(1).toBe(2));');
        const rejectsInvalid = check()===1;
        fs.writeFileSync(fixture,'import {test,expect} from "vitest";test("frozen assertion",()=>expect(1).toBe(1));');
        const acceptsValid = check()===0;
        const passed = Number(process.versions.node.split('.')[0])>=24 && pnpm.status===0 && pnpm.stdout.trim()===${JSON.stringify(input.expectedPnpm)} && install.status===0 && loader.status===0 && loader.stdout.trim()==='ready' && protectedSupervisor() && deniedToolWrite() && rejectsInvalid && acceptsValid && loopback && hostDenied && deniedRead(${JSON.stringify(input.forbiddenFile)}) && deniedRead(${JSON.stringify(path.join(input.sourceRoot, '.git/config'))}) && deniedWrite();
        process.stdout.write(JSON.stringify({passed}));
      })().catch(()=>process.exit(1));
    `;
}
