const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(90000);
 const out='E:/ohif-ai/local-data/acceptance',result={errors:[],states:[]};page.on('pageerror',e=>result.errors.push(e.message));
 await page.addInitScript(()=>window.addEventListener('unhandledrejection',e=>{(window.__rejections||=[]).push(String(e.reason?.stack||e.reason));}));
 try{
 const caseName=process.env.MASK_CASE || 'train_6429_a_1',count=caseName==='valid_254_a_2'?13:2;
 await page.goto('http://127.0.0.1:1026/nifti?manifestId=6e5562936d5746d7bc95c55a9c5e7fe0&caseId=rexgroundingct%3Acase%3A'+caseName);
 await page.waitForFunction(n=>window.services?.segmentationService.getSegmentations().length===n,count);
 if(process.env.MASK_MPR){
   await page.evaluate(()=>window.commandsManager.runCommand('toggleHangingProtocol',{protocolId:'mpr'}));
   await page.waitForFunction(()=>window.services.viewportGridService.getState().viewports.size===3);
   await page.waitForTimeout(2000);
   await page.screenshot({path:out+'/mask-style-mpr.png'});
   result.mprErrors=result.errors.slice();
   await page.evaluate(()=>window.commandsManager.runCommand('toggleHangingProtocol',{protocolId:'mpr'}));
   await page.waitForFunction(()=>window.services.viewportGridService.getState().viewports.size===1);
   await page.waitForTimeout(1000);
   const errors=await page.evaluate(()=>window.__rejections||[]); if(errors.length)throw Error(errors.join('\n'));
 }
 await page.getByRole('button',{name:'标注与 AI',exact:true}).click();
 const target=page.locator('.seg-target').first();await target.locator('.seg-target-title').click();
 await page.waitForTimeout(1100);
 await target.getByRole('button',{name:/^显示设置 /}).click();
 await page.evaluate(()=>{
 const s=window.services.segmentationService;window.__styleCalls=[];const orig=s.setStyle;s.setStyle=(scope,style)=>{window.__styleCalls.push({scope,style});return orig(scope,style);};
 });
 const snapshot=async name=>{
 await page.waitForTimeout(300);
 const state=await page.evaluate(()=>{
 const services=window.services,s=services.segmentationService,v=services.viewportGridService.getState().activeViewportId;
 const vp=services.cornerstoneViewportService.getCornerstoneViewport(v);
 return {active:s.getActiveSegmentation(v)?.segmentationId,calls:window.__styleCalls.slice(-4),styles:s.getSegmentations().map(x=>({id:x.segmentationId,style:s.getStyle({viewportId:v,segmentationId:x.segmentationId,type:'Labelmap'}),segment:s.getStyle({viewportId:v,segmentationId:x.segmentationId,type:'Labelmap',segmentIndex:1})})),actors:vp.getActors().map(e=>{const p=e.actor.getProperty?.();return {uid:e.uid,representationUID:e.representationUID,referencedId:e.referencedId,opacity:p?.getScalarOpacity?.(0)?.getValue?.(1),outline:p?.getLabelOutlineOpacity?.(),width:p?.getLabelOutlineThickness?.(),useOutline:p?.getUseLabelOutline?.()};})};
 });result.states.push({name,...state});console.log(name,JSON.stringify(state.actors.map(a=>({opacity:a.opacity,outline:a.outline,width:a.width?.[0]}))));await page.screenshot({path:out+'/mask-style-'+name+'.png'});
 };
 await snapshot('initial');
 await target.getByRole('slider',{name:/^填充透明度 /}).fill('0');await snapshot('fill-zero');
 await target.getByRole('slider',{name:/^填充透明度 /}).fill('90');await snapshot('fill-high');
 await target.getByRole('button',{name:'仅边界',exact:true}).click();await target.getByRole('slider',{name:/^边界宽度 /}).fill('6');await snapshot('outline');
 await target.getByRole('button',{name:'仅填充',exact:true}).click();await snapshot('fill-only');
 await target.getByRole('button',{name:'填充与边界',exact:true}).click();
 await target.getByRole('slider',{name:/^边界透明度 /}).fill('0');await snapshot('outline-zero');
 await page.locator('.seg-group').first().getByRole('slider',{name:/^整体透明度 /}).fill('0');await snapshot('group-zero');
 await page.getByRole('button',{name:'显示配置',exact:true}).click();
 await page.getByRole('slider',{name:'未选中目标透明度',exact:true}).fill('0');await snapshot('others-zero');
 const active=result.states[0].active;
 const actorsAt=name=>result.states.find(s=>s.name===name).actors.filter(a=>(a.representationUID || a.uid).startsWith(active+'-Labelmap'));
 assert(actorsAt('fill-zero').length>0,'selected mask actor must exist');
 assert(actorsAt('fill-zero').every(a=>a.opacity===0),'zero fill must reach all actors');
 assert(actorsAt('fill-high').every(a=>a.opacity===.9),'high fill must reach all actors');
 assert(actorsAt('outline').every(a=>a.width[0]===6),'outline thickness');
 assert(actorsAt('fill-only').every(a=>a.useOutline===false),'outline is explicitly disabled');
 assert(actorsAt('outline-zero').every(a=>a.outline===0),'zero outline');
 assert(result.states.every(s=>s.actors.length===count+1),'one actor per mask, no duplicates');
 assert(actorsAt('group-zero').every(a=>a.opacity===0 && a.outline===0),'group zero hides fill and outline');
 assert(result.states.find(s=>s.name==='others-zero').actors.filter(a=>a.representationUID?.includes('-Labelmap')).every(a=>a.opacity===0 && (!a.useOutline || a.outline===0 || a.width.every(w=>w===0))),'all hidden targets have no remaining fill or outline');
 assert.equal(result.errors.length,0,result.errors.join('\n'));
 const rejections=await page.evaluate(()=>window.__rejections||[]);assert.equal(rejections.length,0,rejections.join('\n'));
 result.passed=true;
 }catch(e){result.failure=e.stack;await page.screenshot({path:out+'/mask-style-failure.png'}).catch(()=>{});throw e;}
 finally{fs.writeFileSync(out+'/mask-style.json',JSON.stringify(result,null,2));await browser.close();}
})();


