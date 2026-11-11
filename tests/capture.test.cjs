const test=require('node:test'),assert=require('node:assert/strict');
const {vm,source}=require('./helpers.cjs');
function capture(form,opts={}) {
  const messages=[],listeners={}, docListeners={};let interval;
  const root={$children:[{form}]};
  const context=vm.createContext({window:{postMessage(m){messages.push(m);},addEventListener(k,fn){listeners[k]=fn;}},
    document:{visibilityState:opts.hidden?'hidden':'visible',querySelector(){return {__vue__:root};},addEventListener(k,fn){docListeners[k]=fn;}},
    location:{origin:'http://10.198.92.173:8080',href:'http://10.198.92.173:8080'+(opts.path||'/table')},
    URL,Date,AbortController,setTimeout(fn){fn();},clearInterval(){},setInterval(fn){interval=fn;}
  });vm.runInContext(source('content-main.js'),context);return{messages,interval,context,root,listeners};
}
test('/table 的 name 字段捕获车辆，缺失来源时捕获为空',()=>{
  const c=capture({name:'WH-Truck05',mine:'WH',type:'PC'});assert.equal(c.messages[0].payload.truck_no,'WH-Truck05');assert.equal(c.messages[0].payload.hasSource,false);
});
test('/search 的四个筛选捕获完整，隐藏标签不覆盖当前选择',()=>{
  const form={truck_no:'WH-Truck05',mine:'WH',type:'Camera',break_source:'mdc'};
  const c=capture(form,{path:'/search'});assert.equal(c.messages[0].payload.break_source,'mdc');assert.equal(c.messages[0].payload.hasSource,true);
  assert.equal(capture(form,{hidden:true}).messages.length,0);
});
test('切换到 MDC 不清空条件，返回筛选页可再次同步',()=>{
  const c=capture({name:'WH-Truck05',mine:'WH',type:'PC'});
  c.context.location.href='http://10.198.92.173:8080/mdc';c.root.$children[0].form.type='Camera';c.interval();assert.equal(c.messages.length,1);
  c.context.location.href='http://10.198.92.173:8080/search';
  c.root.$children=[{form:{truck_no:'WH-Truck05',mine:'WH',type:'Camera',break_source:''}}];c.interval();assert.equal(c.messages.length,2);
});
test('仅在 table/search 采集，search 不误读保留在组件树中的 table 表单',()=>{
  const form={name:'WH-Truck05',mine:'WH',type:'PC'};
  for(const path of ['/','/mdc','/table/search','/other'])assert.equal(capture(form,{path}).messages.length,0);
  const c=capture(form,{path:'/search'});
  c.root.$children=[{form,regeditForm:{url:'/api/break/search'}},{form:{truck_no:'WH-Truck03',mine:'WH',type:'Perception',break_source:'mdc'},regeditForm:{url:'/api/bag/search'}}];
  c.interval();assert.equal(c.messages.at(-1).payload.truck_no,'WH-Truck03');
  c.root.$children[1].form.truck_no='';c.interval();assert.equal(c.messages.at(-1).payload.truck_no,'');
});
test('经过其他路由返回同一筛选页，值相同也立即重发',()=>{
  const c=capture({truck_no:'WH-Truck05',mine:'WH',type:'Perception',break_source:'mdc'},{path:'/search'});
  c.interval();assert.equal(c.messages.length,1);
  c.context.location.href='http://10.198.92.173:8080/mdc';c.interval();
  c.context.location.href='http://10.198.92.173:8080/search';c.interval();assert.equal(c.messages.length,2);
  c.listeners.message({source:c.context.window,origin:c.context.location.origin,data:{__bagTool:'capture-request'}});
  assert.equal(c.messages.length,3);
});
test('过期、隐藏的 Vue 表单不遮挡当前页面表单',()=>{
  const c=capture({name:'old',mine:'WH',type:'Camera'});
  const form={name:'current',mine:'WH',type:'Perception'};
  c.root.$children=[{_inactive:true,form},{_isDestroyed:true,form},{form,$el:{getClientRects:()=>[]}},{form}];
  c.interval();assert.equal(c.messages.at(-1).payload.truck_no,'current');
});
test('桥接层允许强制刷新相同筛选值，不再次去重',()=>{
  const listeners={},sent=[],window={addEventListener(k,fn){listeners[k]=fn;},postMessage(){}};
  const origin='http://10.198.92.173:8080';
  const context=vm.createContext({AbortController,window,location:{origin},document:{addEventListener(){}},chrome:{
    runtime:{sendMessage:async m=>{sent.push(m);},onMessage:{addListener(){}}},storage:{local:{get:async()=>({tasks:[]})}}
  }});
  vm.runInContext(source('content-bridge.js'),context);
  const event={source:window,origin,data:{__bagTool:'form',payload:{truck_no:'WH-Truck05',captureVersion:2}}};
  listeners.message(event);listeners.message(event);assert.equal(sent.length,2);
  listeners.message({...event,origin:'https://other.invalid'});assert.equal(sent.length,2);
  listeners.message({...event,data:{__bagTool:'form',payload:{truck_no:'old-script'}}});assert.equal(sent.length,2,'旧 MAIN 快照不能覆盖新版本');
});
test('Vue 筛选监听立即捕获变化，重建组件后移除旧监听；清空值也同步',()=>{
  const c=capture({truck_no:'old',mine:'WH',type:'Camera',break_source:'mdc'},{path:'/search'});
  let changed,removed=0;
  const component={form:{truck_no:'new',mine:'HNMZ',type:'Perception',break_source:'nas'},$watch(getter,fn){changed=fn;return()=>removed++;}};
  c.root.$children=[component];c.interval();assert(changed);
  component.form.truck_no='final';component.form.mine='WHKS';component.form.break_source='';changed();
  const payload=c.messages.at(-1).payload;assert.equal(payload.truck_no,'final');assert.equal(payload.mine_code,'WHKS');assert.equal(payload.break_source,'');
  assert.equal(payload.captureVersion,2);assert(payload.sequence>c.messages[0].payload.sequence);
  c.root.$children=[{form:{truck_no:'replacement',mine:'WH',type:'PC'}}];c.interval();assert.equal(removed,1);
});
test('网页不创建顶部告警横幅，旧告警消息也不改页面，筛选捕获仍可请求',()=>{
 let receive, captures=0;
 const context=vm.createContext({AbortController,window:{addEventListener(){},postMessage(){captures++;}},location:{origin:'http://10.198.92.173:8080'},
   document:{addEventListener(){},createElement(){throw Error('不应注入网页告警');}},chrome:{runtime:{onMessage:{addListener(fn){receive=fn;}},sendMessage:async()=>{}}}});
 vm.runInContext(source('content-bridge.js'),context);
 receive({type:'alerts',alerts:[{name:'任务',message:'离线'}]});receive({type:'capture:request'});assert.equal(captures,2);
});
