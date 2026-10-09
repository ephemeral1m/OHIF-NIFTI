const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const base = 'https://server-vanilla.tailb37712.ts.net:9443';
const out = path.resolve('outputs/hospital-10-20261008');
const inventory = JSON.parse(fs.readFileSync(path.join(out,'inventory.json'),'utf8'));
(async () => {
  const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
  const context = await browser.newContext({httpCredentials:{username:process.env.NIFTI_TEST_USERNAME,password:process.env.NIFTI_TEST_PASSWORD,origin:base},viewport:{width:1500,height:1000}});
  const page = await context.newPage(); page.setDefaultTimeout(12*60*1000);
  const network=await context.newCDPSession(page); await network.send('Network.enable');
  const downloads=new Map();
  network.on('Network.responseReceived',e=>{if(e.response.url.endsWith('/file'))downloads.set(e.requestId,0);});
  network.on('Network.dataReceived',e=>{if(downloads.has(e.requestId))downloads.set(e.requestId,downloads.get(e.requestId)+e.dataLength);});
  const progress=setInterval(()=>{if(downloads.size)console.log('Viewer downloaded MiB: '+[...downloads.values()].map(n=>(n/1024**2).toFixed(1)).join(', '));},30000);
  const report = {cases:[],errors:[]}; page.on('pageerror', e=>report.errors.push(e.message));
  try {
    const csv = fs.readFileSync(path.join(out,'hospital_10_images.csv'));
    const preview = await context.request.post(base+'/monai/nifti-images/manifest/preview',{multipart:{file:{name:'hospital_10_images.csv',mimeType:'text/csv',buffer:csv}}});
    assert.equal(preview.status(),200,await preview.text());
    const rows = (await preview.json()).items;
    assert.equal(rows.length,10); assert(rows.every(r=>r.status==='ready'));
    report.csvReady = 10;
    const previous = process.env.HOSPITAL_REUSE_VALIDATED === '1' ? JSON.parse(fs.readFileSync(path.join(out,'registrations.json'),'utf8')) : [];
    for (const item of inventory.cases) {
      const saved = previous.find(c=>c.caseId===item.caseId);
      if (saved) {
        const response = await context.request.get(base+'/monai/nifti-images/'+saved.sourceId+'/metadata');
        assert.equal(response.status(),200); const d=await response.json();
        assert.deepEqual(d.dimensions,item.dimensions); assert.equal(d.modality,'CT');
        report.cases.push(saved); continue;
      }
      const response = await context.request.post(base+'/monai/nifti-images/manifest/open',{data:{image:item.image,segmentations:[],modality:'CT'},timeout:180000});
      assert.equal(response.status(),200,await response.text());
      const opened = await response.json(), d=opened.descriptor;
      assert.deepEqual(d.dimensions,item.dimensions); assert.equal(d.modality,'CT'); assert.equal(opened.errors.length,0);
      report.cases.push({caseId:item.caseId,sourceId:d.sourceId,geometryHash:d.geometryHash,dimensions:d.dimensions,modality:d.modality});
      fs.writeFileSync(path.join(out,'registrations.json'),JSON.stringify(report.cases,null,2));
      console.log(item.caseId+' validated and registered');
    }
    await page.goto(base+'/nifti',{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'导入 CSV / JSON',exact:true}).click();
    await page.getByLabel('原图类型',{exact:true}).selectOption('CT');
    await page.getByLabel('NIfTI 病例清单',{exact:true}).setInputFiles(path.join(out,'hospital_10_images.csv'));
    await page.getByRole('tab',{name:'清单病例',exact:true}).waitFor();
    await page.getByText('HOSP010.nii.gz',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'csv-list.png')});
    report.browserCsvList = true;
    for (const id of (process.env.HOSPITAL_SINGLE_VIEW === '1' ? ['HOSP001'] : ['HOSP001','HOSP009'])) {
      const record=report.cases.find(c=>c.caseId===id);
      await page.goto(base+'/nifti?sourceId='+record.sourceId,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>{try {const s=window.services;return s?.cornerstoneViewportService?.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId)?.getImageIds?.()?.length>200;} catch {return false;}});
      const count=await page.evaluate(async()=>{const s=window.services,v=s.cornerstoneViewportService.getCornerstoneViewport(s.viewportGridService.getState().activeViewportId);const n=v.getImageIds().length;await v.setImageIdIndex(Math.floor(n/2));v.setProperties({voiRange:{lower:-1000,upper:500}});v.render();return n;});
      assert.equal(count,record.dimensions[2]);
      await page.screenshot({path:path.join(out,id+'-viewer.png')});
      record.browserViewed=true; console.log(id+' browser viewer passed');
    }
    assert.deepEqual(report.errors,[]); report.passed=true;
  } catch(e) {report.passed=false;report.failure=e.stack;await page.screenshot({path:path.join(out,'failure.png')});process.exitCode=1;}
  finally { clearInterval(progress); fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify({passed:report.passed,csvReady:report.csvReady,registered:report.cases.length,errors:report.errors,failure:report.failure})); await browser.close(); }
})();
