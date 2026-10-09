const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1600,height:1050}});page.setDefaultTimeout(90000);
 const result={errors:[],steps:[]};page.on('pageerror',e=>result.errors.push(e.message));
 result.inferenceRequests=0;page.on('request',r=>{if(r.method()==='POST'&&/\/infer(?:\?|$|\/)/.test(r.url()))result.inferenceRequests++;});
 try{
 await page.goto('http://127.0.0.1:1026/nifti?manifestId=6e5562936d5746d7bc95c55a9c5e7fe0&caseId=rexgroundingct%3Acase%3Atrain_13092_a_2');
 await page.waitForFunction(()=>window.services?.segmentationService.getSegmentations().length===14);
 await page.getByRole('button',{name:'标注与 AI',exact:true}).click();
 const check=async()=>{
   for(const [id,expected] of [['Probe2','Probe2'],['Brush','CircularBrush'],['PlanarFreehandROI2','PlanarFreehandROI2'],['Eraser','CircularEraser'],['PlanarFreehandROI3','PlanarFreehandROI3'],['Threshold','ThresholdCircularBrushDynamic'],['RectangleROI2','RectangleROI2'],['Shapes','CircleScissor'],['Brush','CircularBrush']]){
     const mode=['Probe2','PlanarFreehandROI2','PlanarFreehandROI3','RectangleROI2'].includes(id)?'AI 提示':'手工编辑';
     await page.getByRole('tab',{name:mode,exact:true}).click();
     const button=page.locator(`.annotation-tools [data-tool="${id}"]`);
     await button.scrollIntoViewIfNeeded();await button.click();
     await page.waitForFunction(expected=>{const s=window.services,v=s.viewportGridService.getActiveViewportId();return s.toolGroupService.getToolGroupForViewport(v)?.getActivePrimaryMouseButtonTool()===expected;},expected);
     const state=await page.evaluate(()=>{const s=window.services,v=s.viewportGridService.getActiveViewportId();return {viewport:v,active:s.toolGroupService.getToolGroupForViewport(v).getActivePrimaryMouseButtonTool(),activeMask:s.segmentationService.getActiveSegmentation(v)?.segmentationId,commandCount:s.toolbarService.getButtonProps('Brush').commands?.length||0};});
     assert(state.activeMask);assert.equal(state.commandCount,0,'registered commands must not accumulate');result.steps.push({id,...state});
   }
 };
 await check();
 await page.getByRole('button',{name:'Change layout',exact:true}).click();
 await page.locator('[data-cy="Axial Primary"]').click();
 await page.waitForFunction(()=>{const s=window.services;return s.viewportGridService.getState().viewports.size===3 && [...s.viewportGridService.getState().viewports.keys()].every(id=>s.cornerstoneViewportService.getCornerstoneViewport(id)?.getActors().length===15);});
 const ids=await page.evaluate(()=>[...window.services.viewportGridService.getState().viewports.keys()]);
 for(const id of ids){await page.evaluate(id=>window.services.viewportGridService.setActiveViewportId(id),id);await check();}
 for(const [label,expected] of [['球形','SphereBrush'],['圆形','CircularBrush'],['球形','SphereBrush'],['圆形','CircularBrush']]){
   await page.locator('.at-settings').getByRole('tab',{name:label,exact:true}).click();
   await page.waitForFunction(expected=>{const s=window.services;return s.toolGroupService.getToolGroupForViewport(s.viewportGridService.getActiveViewportId()).getActivePrimaryMouseButtonTool()===expected;},expected);
 }
 // Paint only in this disposable browser session; never save or call inference.
 const pixels=()=>page.evaluate(async()=>{
   const s=window.services,cache=window.cornerstone.cache;
   return Promise.all(s.segmentationService.getSegmentations().map(async seg=>{
     const buffers=[...new Set(seg.representationData.Labelmap.imageIds.map(id=>cache.getImage(id).voxelManager.getScalarData().buffer))];
     const hashes=await Promise.all(buffers.map(async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('')));
     return {id:seg.segmentationId,hash:hashes.join(',')};
   }));
 });
 result.paint=[];
 for(const id of ids){
   await page.evaluate(id=>window.services.viewportGridService.setActiveViewportId(id),id);
   const brush = page.locator('.annotation-tools [data-tool="Brush"]');
   if (await brush.getAttribute('aria-pressed') !== 'true') await brush.click();
   const before=await pixels();
   const point=await page.evaluate(id=>{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(id),r=v.element.getBoundingClientRect();return {x:r.x+r.width*.52,y:r.y+r.height*.48,mask:s.segmentationService.getActiveSegmentation(id).segmentationId,normal:v.getCamera().viewPlaneNormal};},id);
   await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+8,point.y+5,{steps:4});await page.mouse.up();await page.waitForTimeout(300);
   const after=await pixels(),changed=after.filter((m,i)=>m.hash!==before[i].hash).map(m=>m.id);
   assert.deepEqual(changed,[point.mask],'painting must change exactly the selected mask');
   result.paint.push({viewport:id,normal:point.normal,changed});console.log('Painted MPR plane',point.normal);
 }
 await page.locator('.annotation-tools').screenshot({path:'E:/ohif-ai/local-data/acceptance/tool-studio-manual.png'});
 await page.screenshot({path:'E:/ohif-ai/local-data/acceptance/tool-studio.png'});
 await page.getByRole('tab',{name:'AI 提示',exact:true}).click();
 await page.locator('.annotation-tools').screenshot({path:'E:/ohif-ai/local-data/acceptance/tool-studio-ai.png'});
 assert.deepEqual(result.errors,[]);assert.equal(result.inferenceRequests,0);result.passed=true;
 }finally{fs.writeFileSync('local-data/acceptance/tool-switch.json',JSON.stringify(result,null,2));await browser.close();}console.log(JSON.stringify(result));
})();
