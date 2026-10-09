const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(90000);
 const result={errors:[],states:[]};page.on('pageerror',e=>result.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')result.errors.push(m.text());});
 await page.addInitScript(()=>window.addEventListener('unhandledrejection',e=>{(window.__rejections||=[]).push(String(e.reason?.stack||e.reason));}));
 const snapshot=async name=>{await page.waitForTimeout(1500);result.states.push({name,...await page.evaluate(()=>{const s=window.services;const state=s.viewportGridService.getState();return {hp:s.hangingProtocolService.getState(),layout:state.layout,viewports:[...state.viewports.values()].map(v=>({id:v.viewportId,ds:v.displaySetInstanceUIDs,options:v.viewportOptions,actorCount:s.cornerstoneViewportService.getCornerstoneViewport(v.viewportId)?.getActors()?.length})),rejections:window.__rejections||[]};})});};
 try{
 await page.goto('http://127.0.0.1:1026/nifti?manifestId=6e5562936d5746d7bc95c55a9c5e7fe0&caseId=rexgroundingct%3Acase%3Atrain_13249_b_2');
 await page.waitForFunction(()=>window.services?.segmentationService.getSegmentations().length===6);
 await snapshot('initial');
 if(process.env.GRID_FIRST){
   await page.getByRole('button',{name:'Change layout',exact:true}).click();
   await page.getByRole('button',{name:'布局 1 × 2',exact:true}).click();
   await snapshot('first-grid');
   assert.equal(result.states.at(-1).viewports.length,2);
   assert(result.states.at(-1).viewports.every(v=>v.ds.length===1));
 }
 await page.getByRole('button',{name:'Change layout',exact:true}).click();
 result.palette=await page.locator('.workbench-layout-menu').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,grid:getComputedStyle(el.querySelector('.layout-grid-cell')).backgroundColor}));
 await page.screenshot({path:'E:/ohif-ai/local-data/acceptance/layout-menu.png'});
 await page.locator('[data-cy="Axial Primary"]').click();
 await page.waitForFunction(()=>{
   const s=window.services, state=s.viewportGridService.getState();
   return s.hangingProtocolService.getState().protocolId==='primaryAxial' && state.viewports.size===3 && [...state.viewports.keys()].every(id=>{const v=s.cornerstoneViewportService.getCornerstoneViewport(id);return v?.getImageData()?.scalarData?.length>0 && v.getActors().length===7;});
 });
 await snapshot('axial-first');
 await page.screenshot({path:'E:/ohif-ai/local-data/acceptance/layout-axial-primary.png'});
 for(const [rows,cols] of [[1,2],[2,2],[2,3],[1,1]]){
   await page.getByRole('button',{name:'Change layout',exact:true}).click();
   await page.getByRole('button',{name:`布局 ${rows} × ${cols}`,exact:true}).click();
   await page.waitForFunction(count=>window.services.viewportGridService.getState().viewports.size===count,rows*cols);
   await snapshot(`common-${rows}x${cols}`);
   assert(result.states.at(-1).viewports.every(v=>v.ds.length===1),'all cells contain the current source');
 }
 await page.getByRole('button',{name:'Change layout',exact:true}).click();await page.locator('[data-cy="Layout-1-1"]').click();await snapshot('custom-2x2');
 assert.equal(result.states.at(-1).viewports.length,4);
 assert(result.states.at(-1).viewports.every(v=>v.ds.length===1));
 await page.getByRole('button',{name:'标注与 AI',exact:true}).click();
 result.groupNames=await page.locator('.seg-finding-name').allTextContents();
 assert.equal(result.groupNames.length,2);assert(result.groupNames.every(n=>!n.startsWith('finding_')));
 assert(result.states.every(s=>s.rejections.length===0),JSON.stringify(result.states.map(s=>s.rejections)));
 assert(result.states.every(s=>s.viewports.every(v=>v.actorCount===7)),'all viewports retain all six masks');
 assert.equal(result.palette.bg,'rgb(16, 16, 20)');
 result.passed=true;
 await page.screenshot({path:'E:/ohif-ai/local-data/acceptance/layout-grid.png'});
 }finally{fs.writeFileSync('local-data/acceptance/layout-check.json',JSON.stringify(result,null,2));await browser.close();}
 console.log(JSON.stringify({passed:result.passed,states:result.states.map(s=>({name:s.name,actors:s.viewports.map(v=>v.actorCount)})),names:result.groupNames,palette:result.palette}));
})();

