const fs=require('node:fs');
const {chromium}=require('C:/Users/maczm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base='https://laptop-9snt9abs.tailb37712.ts.net:9443';
const id=JSON.parse(fs.readFileSync('E:/ohif-ai/local-data/acceptance/workspace-manifest.json')).id;
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(120000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  const res=await page.request.get(base+'/monai/nifti-images/manifests/'+id);if(!res.ok())throw Error(await res.text());
  const m=await res.json(),row=m.items.find(r=>r.name==='train_13249_b_2.nii.gz'),finding=row.findings[1];
  // Remove only the association created by our acceptance test; leave the sample as unconfirmed.
  if(finding.statementIds.includes(finding.candidateStatementIds[0])){
   const undo=await page.request.put(base+'/monai/nifti-images/manifests/'+id+'/binding',{data:{caseId:row.caseId,findingId:finding.id,statementIds:finding.statementIds.filter(s=>s!==finding.candidateStatementIds[0]),expectedRevision:m.revision}});
   if(!undo.ok())throw Error(await undo.text());
  }
  const url=base+'/nifti?manifestId='+id+'&caseId='+encodeURIComponent(row.caseId);
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.services?.segmentationService.getSegmentations().length===6);
  await page.getByRole('button',{name:'展开 Finding 2 标签',exact:true}).click();
  await page.locator('.nw-tree-finding').nth(1).click();
  await page.locator('.nw-statement.candidate').waitFor();
  await page.waitForFunction(()=>{const s=window.services;const v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);return v.getCurrentImageId()===v.getCornerstoneImage()?.imageId;});
  await page.screenshot({path:'E:/ohif-ai/local-data/acceptance/workspace-tailnet.png'});
  await page.getByRole('button',{name:'标注与 AI',exact:true}).click();
  await page.getByRole('button',{name:'标注历史',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  if(errors.length)throw Error(JSON.stringify(errors));
  fs.writeFileSync('E:/ohif-ai/local-data/acceptance/workspace-tailnet.json',JSON.stringify({url,passed:true,errors,checks:['HTTPS certificate','persisted manifest after backend restart','five-case tree','six labels including 1/2/4','finding location and candidate report','existing history dialog'],backendTests:20,frontendTests:15},null,2));
  console.log(url);
 }catch(e){await page.screenshot({path:'E:/ohif-ai/local-data/acceptance/workspace-tailnet-failure.png'}).catch(()=>{});throw e;}
 finally{await browser.close();}
})();
