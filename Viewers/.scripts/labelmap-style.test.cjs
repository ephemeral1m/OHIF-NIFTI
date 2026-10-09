const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const filename=path.join(__dirname,'../backup/esm/labelmapDisplay.js');
const script=fs.readFileSync(filename,'utf8').replace(/^import .*;$/gm,'')
 .replace('export const MAX_NUMBER_COLORS','const MAX_NUMBER_COLORS')
 .replace(/export default \{[\s\S]*?\};/,'').replace(/export \{.*\};/,'');
function renderer(preLoad=false){
 const props={outline:false,width:[0],opacity:0,setUseLabelOutline(v){this.outline=v;},setLabelOutlineOpacity(v){this.opacity=v;},setLabelOutlineThickness(v){this.width=v;},setRGBTransferFunction(){},setScalarOpacity(){},setInterpolationTypeToNearest(){},modified(){}};
 const actor={getProperty:()=>props,getMapper:()=>({modified(){}}),modified(){},setVisibility(){}};
 if(preLoad)actor.get=()=>({preLoad(){}});
 const ofun={value:null,getMTime:()=>0,removePoint(){},addPointLong(i,v){if(i===1)this.value=v;},setClamping(){}};
 const cfun={getMTime:()=>0,addRGBPoint(){}};
 const state={style:{renderFill:true,fillAlpha:.45,renderOutline:true,outlineOpacity:1,outlineWidth:1,activeSegmentOutlineWidthDelta:0},entries:[{referencedId:'slice',actor}],added:0};
 const context={console,VolumeViewport:class {},getSegmentation:()=>({representationData:{Labelmap:{imageIds:['slice']}}}),
 getLabelmapActorEntries:()=>state.entries,getCurrentLabelmapImageIdsForViewport:()=>['slice'],
 getActiveSegmentation:()=>({segmentationId:'mask'}),getActiveSegmentIndex:()=>1,
 getColorLUT:()=>[[0,0,0,0],[200,100,50,255]],internalGetHiddenSegmentIndices:()=>new Set(),
 segmentationStyle:{getStyle:()=>state.style,getRenderInactiveSegmentations:()=>true},
 SegmentationRepresentations:{Labelmap:'Labelmap'},addLabelmapToElement:async()=>{state.added++;state.entries=[{referencedId:'slice',actor}];}};
 vm.createContext(context);vm.runInContext(script,context);
 return {state,props,ofun,render:()=>context.render({id:'viewport',getCurrentImageId:()=>Math.random()}, {segmentationId:'mask',config:{cfun,ofun}})};
}
test('reused Stack actor is not duplicated on navigation; missing actor is recreated',async()=>{
 const r=renderer();await r.render();await r.render();assert.equal(r.state.added,0);
 r.state.entries=[];await r.render();assert.equal(r.state.added,1);
});
test('fill, outline-only, zero opacity and explicit outline disable reach renderer',async()=>{
 for(const preLoad of [false,true]){
 const r=renderer(preLoad);await r.render();assert.equal(r.ofun.value,.45);assert.equal(r.props.outline,true);
 r.state.style.fillAlpha=0;await r.render();assert.equal(r.ofun.value,0);
 r.state.style.renderFill=false;r.state.style.outlineWidth=6;await r.render();assert.equal(r.props.width[0],6);
 r.state.style.outlineOpacity=0;await r.render();assert.equal(r.ofun.value,0);assert.equal(r.props.opacity,0);
 r.state.style.renderFill=true;r.state.style.fillAlpha=.8;r.state.style.renderOutline=false;
 await r.render();assert.equal(r.ofun.value,.8);assert.equal(r.props.outline,false);assert.equal(r.props.width[0],0);
 }
});
