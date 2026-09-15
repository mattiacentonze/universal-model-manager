#!/usr/bin/env node
import{J as C,K as E,L as X,r as $,y as q,z as B}from"./index-zf3axndm.js";import{ua as Y}from"./index-8f1200qx.js";import"./index-nrvjr97q.js";import{Ka as Z}from"./index-zxqb5ydj.js";import{execFileSync as U}from"node:child_process";function V(z,K=process.platform,H=U){try{if(K==="win32"){H("cmd",["/c","start","",z],{stdio:"ignore",timeout:3000});return}H(K==="darwin"?"open":"xdg-open",[z],{stdio:"ignore",timeout:3000})}catch{}}function W(){console.log(`Usage:
  npx @cortexkit/opencode-openai-auth login [--label <name>] [--headless]
  npx @cortexkit/opencode-openai-auth list
  npx @cortexkit/opencode-openai-auth remove <id>

Fallback accounts are stored in:
  ${Y()}`)}function P(z){let K=[],H={};for(let N=0;N<z.length;N++){let j=z[N];if(!j)continue;if(j.startsWith("--")){let J=j.slice(2),D=z[N+1];if(D&&!D.startsWith("--"))H[J]=D,N++;else H[J]=!0}else K.push(j)}return{positional:K,flags:H}}async function R(){let{positional:z,flags:K}=P(process.argv.slice(2)),[H,...N]=z;if(!H||H==="help")W(),process.exit(0);switch(H){case"login":{let j=typeof K.label==="string"?K.label:void 0,J=Boolean(K.headless);try{$(j)}catch(G){console.error(`
Error: ${G instanceof Error?G.message:String(G)}`),process.exit(1)}let{url:D,instructions:M,completion:T}=await B({label:j,headless:J});if(console.log(`
Open this URL in your browser and complete sign-in:
`),console.log(`${D}
`),M)console.log(`${M}
`);V(D);let O=await T,Q=!1;if(await X((G)=>{if(O.accountId&&G.mainAccountId&&O.accountId===G.mainAccountId)return Q=!0,G;return q(G.accounts,O),G}),Q)console.error(`
Error: that account is already your main (same ChatGPT account).`),console.error("A self-fallback would retry on the account that just returned 429."),process.exit(1);if(console.log(`
✓ Added account ${O.id}`),O.label)console.log(`  Label: ${O.label}`);break}case"list":{let j=await E();if(!j||j.accounts.length===0)console.log("No fallback accounts configured.");else for(let J of j.accounts){let D=J.label,M=[`  ${J.id}`];if(D)M.push(`(${D})`);M.push(J.enabled!==!1?"[enabled]":"[disabled]"),console.log(M.join(" "))}break}case"remove":{let j=N[0];if(!j)console.error("Error: remove requires an account ID."),W(),process.exit(1);let J=Y(),D=await C(J),M=D?D.has(j):!1,T=!1;if(await X((Q)=>{let G=Q.accounts.findIndex((L)=>L.id===j);if(G===-1)return Q;return Q.accounts.splice(G,1),T=!0,Q},J,{allowDrop:[j]}),!(T||M))console.error(`No account with id "${j}".`),process.exit(1);console.log(`Removed account ${j}.`);break}default:console.error(`Unknown command: ${H}`),W(),process.exit(1)}}if(Z.main==Z.module)R().catch((z)=>{console.error(z instanceof Error?z.message:String(z)),process.exit(1)});export{V as openBrowserForLogin};
