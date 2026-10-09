const fs=require('node:fs'), assert=require('node:assert/strict');
const {chromium}=require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base='http://127.0.0.1:1026',out='E:/ohif-ai/local-data/acceptance';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(90000);
 const report={checks:[],errors:[]};page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());
 const waitMasks=n=>page.waitForFunction(n=>window.services?.segmentationService.getSegmentations().length===n,n);
 const check=s=>{console.log(s);report.checks.push(s);};
 try{
  await page.goto(base+'/nifti?manifestId=6e5562936d5746d7bc95c55a9c5e7fe0&caseId=rexgroundingct%3Acase%3Atrain_12470_a_1');await waitMasks(3);
  await page.waitForFunction(()=>!document.body.textContent.includes('下载中'));
  const initial=await page.evaluate(()=>({source:window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot().sources,background:getComputedStyle(document.querySelector('.ohif-workbench-header')).backgroundImage}));
  assert(initial.background.includes('linear-gradient'));
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('menu').waitFor();await page.keyboard.press('Escape');check('Modern header palette and settings menu');
  await page.evaluate(()=>{window.__workbenchNode=document.querySelector('.nw-shell');window.__sawHome=false;new MutationObserver(()=>{if(document.querySelector('h1')?.textContent==='NIfTI 检查列表')window.__sawHome=true;}).observe(document.body,{childList:true,subtree:true});});
  await page.getByRole('button',{name:'打开病例 train_13249_b_2.nii.gz',exact:true}).click();
  await page.waitForFunction(()=>new URLSearchParams(location.search).get('caseId')==='rexgroundingct:case:train_13249_b_2'||document.querySelector('.nw-error')?.textContent);
  assert(page.url().includes('train_13249'),await page.locator('.nw-error').allTextContents());await waitMasks(6);
  const state=await page.evaluate(()=>({same:window.__workbenchNode===document.querySelector('.nw-shell'),home:window.__sawHome,memory:window.extensionManager.getModuleEntry('@ohif/extension-nifti.utilityModule.diagnostics').exports.memorySnapshot()}));
  assert(state.same);assert(!state.home);assert.equal(state.memory.sources,1);check('In-place case switch: shell retained, no home route, old source released, six masks loaded');
  await page.locator('.nw-tree-finding').nth(1).click();await page.locator('.nw-selected').waitFor();
  await page.screenshot({path:out+'/inplace-workbench.png'});
  await page.route('**/nifti-images/manifest/open',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'模拟网络错误'})}));
  await page.getByRole('button',{name:'打开病例 train_12470_a_1.nii.gz',exact:true}).click();await page.getByRole('alert').filter({hasText:'模拟网络错误'}).waitFor();
  assert(page.url().includes('train_13249'));await waitMasks(6);check('Preparation failure preserves previous image and six masks');
  await page.unroute('**/nifti-images/manifest/open');
  await page.getByRole('button',{name:'打开病例 train_12470_a_1.nii.gz',exact:true}).click();
  await page.waitForFunction(()=>new URLSearchParams(location.search).get('caseId')==='rexgroundingct:case:train_12470_a_1');await waitMasks(3);check('Retry switches back without leaving workspace');
  await page.getByRole('button',{name:'标注与 AI',exact:true}).click();
  await page.getByRole('button',{name:'新建二值 mask',exact:true}).click();await waitMasks(4);
  page.removeAllListeners('dialog');let confirmed=false;page.once('dialog',async d=>{confirmed=true;await d.dismiss();});
  await page.getByRole('button',{name:'打开病例 train_13249_b_2.nii.gz',exact:true}).click();
  assert(confirmed);assert(page.url().includes('train_12470'));await waitMasks(4);check('Unsaved-mask confirmation can cancel a switch without losing edits');
  page.on('dialog',d=>d.accept());
  await page.evaluate(()=>window.commandsManager.runCommand('toggleHangingProtocol',{protocolId:'mpr'}));
  await page.waitForFunction(()=>window.services.viewportGridService.getState().viewports.size===3);
  await page.getByRole('button',{name:'打开病例 train_13249_b_2.nii.gz',exact:true}).click();
  await page.waitForFunction(()=>new URLSearchParams(location.search).get('caseId')==='rexgroundingct:case:train_13249_b_2');await waitMasks(6);
  assert.equal(await page.evaluate(()=>window.services.viewportGridService.getState().viewports.size),1);check('MPR case switches back to a clean Stack without retaining old volumes');
  await page.reload();await waitMasks(6);check('Updated URL refreshes to correct case');
  assert.equal(report.errors.length,0,report.errors.join('\n'));report.passed=true;
 }catch(e){report.failure=e.stack;await page.screenshot({path:out+'/inplace-failure.png'}).catch(()=>{});throw e;}
 finally{fs.writeFileSync(out+'/inplace.json',JSON.stringify(report,null,2));await browser.close();}
})();
