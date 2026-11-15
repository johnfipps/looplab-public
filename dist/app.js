import {createDanceStage} from './dance-stage.js';
import {MAX_SONG_BARS,clamp,stepOffset,noteOffset,gridPosition,midiEventTime,midiRecordPosition,midiNoteLength,writeMidiHit,emptyPattern,takePatternColor,copy,moveNote,resizeNote,recordNoteExpression,INSTRUMENTS,INSTRUMENT_GROUPS,defaultDrumMidi,drumMidiPreset,miniLabMixerTarget,isMiniLabInput,routeMidiNote,learnDrumNote,PRESETS,ENVELOPES,KITS,DRUM_TYPES,MODELED_INSTRUMENTS,ENGINES,applyDrumKit,currentKit,isTrackAudible,trackTriggerPitch,DEMO_TITLE,demoProject,freshProject,normalize} from './core.js';
import {StudioAudio,playPatternStep,renderSong,filterCutoff} from './audio.js';
const $=id=>document.getElementById(id), audio=new StudioAudio();
const secondaryTransport=$('primaryTransport').cloneNode(true);
secondaryTransport.id='secondaryTransport';
secondaryTransport.setAttribute('aria-label','Piano roll transport');
for(const button of secondaryTransport.querySelectorAll('button')){
 const id=button.id;
 button.id=id+'Lower';
 button.onclick=()=>$(id).click();
}
$('lowerTransport').append(secondaryTransport);
const fxKeys=['pitch','overdrive','compressor','filter','reverb','delay','delayTime'];
let project=freshProject(),selected=4,patternId='p1',drag=null,playing=false,phase='stopped',timer,events=[],current=-1,playPatternId=null,playSlot=-1,cursor=null,barHistory=[],countCursor=0,countStart=0,countTempo=112,midiAccess,selectedMidiInput="",connectingMidi=false,midiPermission='unknown',liveNotes=new Map(),pedals=new Set(),padLearning=-1;
audio.getBpm=()=>project.bpm;audio.getTracks=()=>project.tracks;audio.isAudible=t=>isTrackAudible(t,project.tracks);
const selectedNotes=new Set();
let noteClipboard=[],selectingNotes=false,pastingNotes=false;
const pattern=()=>project.patterns.find(p=>p.id===patternId)||project.patterns[0],part=()=>pattern().parts[selected],track=()=>project.tracks[selected],stepDur=()=>60/project.bpm/4;
let midiPaintFrame=0,midiSaveTimer=0,midiPaint={steps:false,roll:false,message:null};
function deferMidiUi({steps=false,roll=false,save:shouldSave=false,message=null}={}){midiPaint.steps||=steps;midiPaint.roll||=roll;if(message)midiPaint.message=message;if(shouldSave){clearTimeout(midiSaveTimer);midiSaveTimer=setTimeout(()=>save('midi'),180)}if(!midiPaintFrame)midiPaintFrame=requestAnimationFrame(()=>{midiPaintFrame=0;let pending=midiPaint;midiPaint={steps:false,roll:false,message:null};if(pending.roll)paintNotes();else if(pending.steps)refreshStepCells();if(pending.message)$('lastMidi').textContent=pending.message})}
const screenKeys=new Map(), screenVoices=new Set(), midiExpression=new Map();
const studioExpression={bend:0,mod:0};
function displayExpression({bend,mod}){
 $('bend').value=Math.round(bend*100);
 $('mod').value=Math.round(mod*100);
 $('bend').setAttribute('aria-valuetext',(bend*2).toFixed(2)+' semitones');
 $('modValue').textContent=Math.round(mod*100)+'%';
}
function adjustExpression(control,value){
 studioExpression[control]=value;
 displayExpression(studioExpression);
 for(const voice of screenVoices)if(voice.track===track())voice.express(studioExpression);
 for(const entry of liveNotes.values())if(!entry.pad&&entry.voice?.track===track()){
  const state={...(midiExpression.get(entry.channel)||studioExpression),[control]:value};
  midiExpression.set(entry.channel,state);
  entry.voice.express(state);
  captureExpression(entry,state);
 }
}
$('bend').oninput=()=>adjustExpression('bend',+$('bend').value/100);
$('mod').oninput=()=>adjustExpression('mod',+$('mod').value/100);
$('centerBend').onclick=()=>adjustExpression('bend',0);

const pianoKeyActions=new WeakMap();
const pianoGrid=$('roll');
const pianoKeys=new Map();
let litMidiPitches=new Set();
function paintMidiKeys(){
 const pitches=new Set();
 for(const entry of liveNotes.values()){
  if(!entry.released&&!entry.pad&&entry.track===track())pitches.add(entry.pitch);
 }
 for(const pitch of litMidiPitches)if(!pitches.has(pitch))pianoKeys.get(pitch)?.classList.remove('midiPressed');
 for(const pitch of pitches)if(!litMidiPitches.has(pitch))pianoKeys.get(pitch)?.classList.add('midiPressed');
 litMidiPitches=pitches;
}
let pianoPointer=null;

function finishPianoPointer(event){
 if(!pianoPointer||(event&&event.pointerId!==pianoPointer.id))return;
 const {id,key}=pianoPointer;
 pianoPointer=null;
 pianoKeyActions.get(key)?.release();
 if(pianoGrid.hasPointerCapture(id))pianoGrid.releasePointerCapture(id);
}
function releaseScreenKeys(){
 finishPianoPointer();
 for(const release of [...screenKeys.values()])release();
}
pianoGrid.addEventListener('pointerdown',event=>{
 const key=event.target.closest('.key');
 if(!key||event.button!==0||pianoPointer)return;
 event.preventDefault();
 key.focus({preventScroll:true});
 pianoPointer={id:event.pointerId,key};
 pianoGrid.setPointerCapture(event.pointerId);
 pianoKeyActions.get(key).press();
});
pianoGrid.addEventListener('pointermove',event=>{
 if(event.pointerId!==pianoPointer?.id)return;
 const key=document.elementFromPoint(event.clientX,event.clientY)?.closest('#roll .key')??null;
 if(key===pianoPointer.key)return;
 pianoKeyActions.get(pianoPointer.key)?.release();
 pianoPointer.key=key;
 pianoKeyActions.get(key)?.press();
});
for(const event of ['pointerup','pointercancel','lostpointercapture']){
 pianoGrid.addEventListener(event,finishPianoPointer);
}

function wirePianoKey(key,pitch){
 let down=false,voice=null,token=0;
 const release=()=>{
  down=false;
  token++;
  key.classList.remove('pressed');
  key.setAttribute('aria-pressed','false');
  voice?.release();
  screenVoices.delete(voice);
  voice=null;
  screenKeys.delete(key);
 };
 const press=()=>{
  if(down)return;
  down=true;
  const attempt=++token,pressedTrack=track();
  key.classList.add('pressed');
  key.setAttribute('aria-pressed','true');
  screenKeys.set(key,release);
  audio.init(project.master).then(()=>{
   if(!down||token!==attempt)return;
   voice=audio.play(pressedTrack,pitch,audio.ctx.currentTime,.3,.8,true,studioExpression);
   if(voice)screenVoices.add(voice);
  }).catch(()=>{
   if(token!==attempt)return;
   release();
   toast('Press Play to enable audio, then try the key again.');
  });
 };
 pianoKeyActions.set(key,{press,release});
 key.setAttribute('aria-pressed','false');
 key.onclick=event=>event.preventDefault();
 key.onblur=()=>{if(pianoPointer?.key!==key)release()};
 key.onkeydown=event=>{
  if(event.code!=='Space'&&event.code!=='Enter')return;
  event.preventDefault();
  event.stopPropagation();
  if(!event.repeat&&!pianoPointer)press();
 };
 key.onkeyup=event=>{
  if(event.code!=='Space'&&event.code!=='Enter')return;
  event.preventDefault();
  event.stopPropagation();
  if(pianoPointer?.key!==key)release();
 };
}
const pitchName=p=>['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][p%12]+(Math.floor(p/12)-1);
function toast(s){$('toast').textContent=s;$('toast').style.display='block';clearTimeout(toast.t);toast.t=setTimeout(()=>$('toast').style.display='none',4200)}
const undoHistory=[],redoHistory=[];
let lastSnapshot,lastEditGroup,lastEditAt=0;
function updateHistoryButtons(){
 $('undo').disabled=!undoHistory.length;
 $('redo').disabled=!redoHistory.length;
 $('undoLower').disabled=$('undo').disabled;
 $('redoLower').disabled=$('redo').disabled;
}
function persistProject(snapshot){
 try{
  localStorage.setItem('looproom-v2',snapshot);
  $('saveState').textContent='Saved on this device';
 }catch{$('saveState').textContent='Use Save project to keep your work'}
}
function save(group=null){
 const snapshot=JSON.stringify(project);
 if(snapshot===lastSnapshot)return;
 const now=performance.now();
 if(lastSnapshot!==undefined&&!(group&&group===lastEditGroup&&now-lastEditAt<650)){
  undoHistory.push(lastSnapshot);
  if(undoHistory.length>20)undoHistory.shift();
 }
 lastSnapshot=snapshot;
 lastEditGroup=group;
 lastEditAt=now;
 redoHistory.length=0;
 persistProject(snapshot);
 updateHistoryButtons();
}
function restoreHistory(from,to){
 stop();
 clearTimeout(midiSaveTimer);
 save('midi');
 if(!from.length)return;
 to.push(lastSnapshot);
 lastSnapshot=from.pop();
 lastEditGroup=null;
 loadProject(JSON.parse(lastSnapshot),selected,false);
 persistProject(lastSnapshot);
 updateHistoryButtons();
}
$('undo').onclick=()=>restoreHistory(undoHistory,redoHistory);
$('redo').onclick=()=>restoreHistory(redoHistory,undoHistory);

function button(text,fn,cls=''){let b=document.createElement('button');b.textContent=text;b.onclick=fn;b.className=cls;return b}
function render(){renderTransport();renderPatterns();renderSteps();renderRoll();renderSound()}
function renderTransport(){renderDrumMidi();$('title').value=project.title;$('bpm').value=project.bpm;$('master').value=project.master;$('metronomeVolume').value=Math.round(project.metronomeVolume*100);$('metronomeVolumeValue').textContent=Math.round(project.metronomeVolume*100)+'%';$('midiQuantize').setAttribute('aria-pressed',project.midiQuantize);$('swing').value=Math.round(project.swing*100);$('swingValue').textContent=Math.round(project.swing*100)+'%';['countIn','metronome'].forEach(k=>$(k).setAttribute('aria-pressed',project[k]));$('patternMode').setAttribute('aria-pressed',project.mode==='pattern');$('songMode').setAttribute('aria-pressed',project.mode==='song')}
function renderPatternHeading(){let p=pattern();$('sequencerPatternName').textContent=p.name;document.querySelector('.sequencer').style.setProperty('--pattern',p.color)}
let selectedSongSlot=-1;
function renderPatterns(){
 patternTabs.replaceChildren();
 for(const p of project.patterns){
  const tab=button(p.name,()=>selectPattern(p.id),'patternTab'+(p.id===playPatternId?' playing':''));
  tab.style.setProperty('--pattern',p.color);
  tab.dataset.pattern=p.id;
  tab.draggable=true;
  tab.title='Drag to reorder or add to the song. Alt + Left or Right to reorder.';
  tab.setAttribute('aria-keyshortcuts','Alt+ArrowLeft Alt+ArrowRight');
  tab.ondragstart=event=>{
   event.dataTransfer.setData(patternDragType,p.id);
   event.dataTransfer.effectAllowed='copyMove';
  };
  tab.onkeydown=event=>{
   if(!event.altKey||!['ArrowLeft','ArrowRight'].includes(event.key))return;
   event.preventDefault();
   const index=project.patterns.indexOf(p);
   movePattern(p.id,index+(event.key==='ArrowRight'?2:-1));
  };
  patternTabs.append(tab);
 }
 refreshPatternSelection();
 songSlots.replaceChildren();project.song.forEach((id,i)=>{let p=project.patterns.find(p=>p.id===id),slot=document.createElement('div');slot.className='songSlot'+(i===playSlot&&playing&&project.mode==='song'?' playing':'');slot.style.setProperty('--pattern',p.color);slot.dataset.slot=i;
 const label=button(String(i+1).padStart(2,'0')+' · '+p.name,()=>{
  selectedSongSlot=i;
  if(!playing||project.mode!=='song'||id===playPatternId)selectPattern(id);
  else renderPatterns();
  songSlots.children[i]?.firstElementChild.focus({preventScroll:true});
 });
 const selectedSlot=i===selectedSongSlot;
 slot.classList.toggle('selectedSongSlot',selectedSlot);
 label.setAttribute('aria-pressed',selectedSlot);
 slot.draggable=true;
 slot.onclick=event=>{if(event.target===slot)label.click()};
 label.title='Drag to move this bar';
 label.dataset.bar=String(i+1).padStart(2,'0');
 label.draggable=true;
 slot.ondragstart=event=>{
  const control=event.target.closest('button');
  if(control&&control!==label){event.preventDefault();return}
  event.dataTransfer.setData(songBarDragType,String(i));
  event.dataTransfer.effectAllowed='move';
 };
 label.onkeydown=event=>{
  if(event.key==='Delete'||event.key==='Backspace'){
   event.preventDefault();
   event.stopPropagation();
   removeSongBar(i);
   songSlots.children[Math.min(i,project.song.length-1)]?.firstElementChild.focus();
  }else if(event.altKey&&['ArrowLeft','ArrowRight'].includes(event.key)){
   event.preventDefault();
   const delta=event.key==='ArrowLeft'?-1:1;
   moveSongBar(i,i+delta+(delta>0?1:0));
   songSlots.children[i+delta]?.firstElementChild.focus();
  }
 };
 slot.append(label);songSlots.append(slot)});
 if(project.song.length>8)songSlots.append(songTurn);
 $('songCount').textContent=project.song.length+' / '+MAX_SONG_BARS+' bars';
 $('makePatternUnique').disabled=selectedSongSlot<0||project.patterns.length>=64;updateSongPlayhead()}
const patternDragType='application/x-looplab-pattern';
const songBarDragType='application/x-looplab-song-bar';
const songSlots=$('songSlots'),patternTabs=$('patterns'),songTurn=$('songTurn');
function cardDropPosition(cards,x,y){
 let nearest=null,bestDistance=Infinity;
 for(const [index,tab] of Array.from(cards).entries()){
  const box=tab.getBoundingClientRect();
  const dx=Math.max(box.left-x,0,x-box.right),dy=Math.max(box.top-y,0,y-box.bottom);
  const distance=dx*dx+dy*dy;
  if(distance>=bestDistance)continue;
  bestDistance=distance;
  const after=x>=box.left+box.width/2;
  nearest={tab,after,index:index+Number(after)};
 }
 return nearest;
}
function clearPatternDrop(){
 patternTabs.querySelector('.dropBefore,.dropAfter')?.classList.remove('dropBefore','dropAfter');
}
patternTabs.ondragover=event=>{
 if(!event.dataTransfer.types.includes(patternDragType))return;
 event.preventDefault();
 event.dataTransfer.dropEffect='move';
 clearPatternDrop();
 const target=cardDropPosition(patternTabs.children,event.clientX,event.clientY);
 target?.tab.classList.add(target.after?'dropAfter':'dropBefore');
};
patternTabs.ondragleave=event=>{
 if(!patternTabs.contains(event.relatedTarget))clearPatternDrop();
};
patternTabs.ondrop=event=>{
 if(!event.dataTransfer.types.includes(patternDragType))return;
 event.preventDefault();
 const target=cardDropPosition(patternTabs.children,event.clientX,event.clientY);
 clearPatternDrop();
 if(target)movePattern(event.dataTransfer.getData(patternDragType),target.index);
};
function movePattern(id,boundary){
 const from=project.patterns.findIndex(pattern=>pattern.id===id);
 const to=boundary>from?boundary-1:boundary;
 if(from<0||to===from||to<0||to>=project.patterns.length)return;
 const tab=patternTabs.children[from],next=patternTabs.children[boundary]??null;
 const [pattern]=project.patterns.splice(from,1);
 project.patterns.splice(to,0,pattern);
 patternTabs.insertBefore(tab,next);
 tab.focus({preventScroll:true});
 save();
}
function songDropType(transfer){
 if(transfer.types.includes(songBarDragType))return songBarDragType;
 if(transfer.types.includes(patternDragType))return patternDragType;
 return null;
}
function clearDropTarget(){
 songSlots.querySelector('.dropBefore,.dropAfter')?.classList.remove('dropBefore','dropAfter');
}
songSlots.ondragenter=songSlots.ondragover=event=>{
 const type=songDropType(event.dataTransfer);
 if(!type)return;
 event.preventDefault();
 clearDropTarget();
 if(type===patternDragType&&project.song.length>=MAX_SONG_BARS){
  event.dataTransfer.dropEffect='none';
  return;
 }
 event.dataTransfer.dropEffect=type===songBarDragType?'move':'copy';
 const target=cardDropPosition(songSlots.querySelectorAll('.songSlot'),event.clientX,event.clientY);
 target?.tab.classList.add(target.after?'dropAfter':'dropBefore');
};
songSlots.ondragleave=event=>{
 if(!songSlots.contains(event.relatedTarget))clearDropTarget();
};
const trash=$('deletePattern');
function closeTrash(){trash.classList.remove('dragOver')}
trash.ondragover=event=>{
 if(!songDropType(event.dataTransfer))return;
 event.preventDefault();
 event.dataTransfer.dropEffect='move';
 trash.classList.add('dragOver');
};
trash.ondragleave=event=>{if(!trash.contains(event.relatedTarget))closeTrash()};
document.addEventListener('dragend',()=>{clearDropTarget();clearPatternDrop();closeTrash()});
trash.ondrop=event=>{
 const type=songDropType(event.dataTransfer);
 if(!type)return;
 event.preventDefault();
 closeTrash();
 clearDropTarget();
 const value=event.dataTransfer.getData(type);
 if(!value)return;
 if(type===songBarDragType)removeSongBar(Number(value));
 else deletePattern(value);
};
songSlots.ondrop=event=>{
 const type=songDropType(event.dataTransfer);
 if(!type)return;
 event.preventDefault();
 const value=event.dataTransfer.getData(type);
 const {index}=cardDropPosition(songSlots.querySelectorAll('.songSlot'),event.clientX,event.clientY)??{index:0};
 clearDropTarget();
 if(type===songBarDragType){
  if(value!=='')moveSongBar(Number(value),index);
 }else insertSongPattern(value,index);
};
function moveSongBar(from,boundary){
 if(!Number.isInteger(from)||from<0||from>=project.song.length)return;
 const to=boundary>from?boundary-1:boundary;
 if(to===from||to<0||to>=project.song.length)return;
 stop();
 const [id]=project.song.splice(from,1);
 project.song.splice(to,0,id);
 if(selectedSongSlot===from)selectedSongSlot=to;
 else if(from<selectedSongSlot&&selectedSongSlot<=to)selectedSongSlot--;
 else if(to<=selectedSongSlot&&selectedSongSlot<from)selectedSongSlot++;
 renderPatterns();
 save();
}
function insertSongPattern(id,index=project.song.length){
 if(!project.patterns.some(pattern=>pattern.id===id))return;
 if(project.song.length>=MAX_SONG_BARS){toast('Maximum '+MAX_SONG_BARS+' song bars.');return}
 stop();
 project.song.splice(index,0,id);
 if(index<=selectedSongSlot)selectedSongSlot++;
 renderPatterns();
 save();
}
function refreshPatternSelection(){
 const p=pattern();
 renderPatternHeading();
 for(const tab of patternTabs.children){
  const active=tab.dataset.pattern===p.id;
  tab.classList.toggle('selected',active);
  tab.setAttribute('aria-pressed',active);
 }
 if(!$('patternName').editingPattern)$('patternName').value=p.name;
 if(!$('patternColor').editingPattern)$('patternColor').value=p.color;
}
function selectPattern(id,follow=false){
 if(playing&&project.mode==='song'&&!follow&&id!==playPatternId){
  toast('Stop song playback to select a different pattern.');
  return;
 }
 drag=null;
 patternId=id;
 clearNoteSelection();
 if(follow)refreshPatternSelection();
 else renderPatterns();
 renderRoll();
 if(playing&&project.mode==='pattern')toast('Pattern switches at the next bar.');
}
function removeSongBar(index){
 if(!Number.isInteger(index)||index<0||index>=project.song.length)return;
 if(project.song.length===1){toast('Keep at least one bar in the song.');return}
 stop();
 project.song.splice(index,1);
 if(selectedSongSlot===index)selectedSongSlot=-1;
 else if(selectedSongSlot>index)selectedSongSlot--;
 renderPatterns();
 save();
}
function deletePattern(id){
 if(!project.patterns.some(p=>p.id===id))return;
 if(project.patterns.length===1){toast('Keep at least one pattern in the project.');return}
 stop();
 project.patterns=project.patterns.filter(p=>p.id!==id);
 project.song=project.song.filter(pattern=>pattern!==id);
 selectedSongSlot=-1;
 if(patternId===id)patternId=project.patterns[0].id;
 if(!project.song.length)project.song=[patternId];
 clearNoteSelection();
 render();
 save();
}
let drumsArmed=false,armedInstrument=null;
function isTrackArmed(index){
 const track=project.tracks[index];
 return !!track&&(DRUM_TYPES.includes(track.type)?drumsArmed:armedInstrument===index);
}
function refreshRecordArms(){
 const hasDrums=project.tracks.some(track=>DRUM_TYPES.includes(track.type));
 if(!hasDrums)drumsArmed=false;
 if(armedInstrument!==null&&DRUM_TYPES.includes(project.tracks[armedInstrument].type))armedInstrument=null;
 for(const entry of liveNotes.values()){
  if(entry.record&&!isTrackArmed(project.tracks.indexOf(entry.track))){
   finishHeld(entry);
   entry.record=null;
  }
 }
 for(const arm of $('steps').querySelectorAll('.trackArm')){
  const index=+arm.dataset.armTrack,track=project.tracks[index];
  const group=DRUM_TYPES.includes(track.type);
  arm.setAttribute('aria-pressed',isTrackArmed(index));
  arm.setAttribute('aria-label','Record arm for track '+(index+1)+', '+track.name);
  arm.title=group?'Arm or disarm all drum tracks':'Arm or disarm MIDI recording for '+track.name;
 }
 const targets=[];
 if(drumsArmed)targets.push('Drums');
 if(armedInstrument!==null)targets.push(project.tracks[armedInstrument].name+' (keys)');
 $('recordStatus').textContent=targets.length?'Armed · '+targets.join(' + '):'Arm a track to record MIDI';
 $('recordStatus').classList.toggle('armed',targets.length>0);
}
function toggleRecordArm(index,selectTrack){
 if(DRUM_TYPES.includes(project.tracks[index].type))drumsArmed=!drumsArmed;
 else{
  armedInstrument=armedInstrument===index?null:index;
  if(armedInstrument!==null)selectTrack();
 }
 refreshRecordArms();
}
function renderTrackControls(grid,t,i){
 const num=document.createElement('div');
 num.className='tracknum trackIndex';
 const number=button(String(i+1).padStart(2,'0'),()=>{selectTrack();auditionTrack(project.tracks[i])},'trackSelect');
 number.setAttribute('aria-label','Select and audition track '+(i+1));
 number.setAttribute('aria-pressed',i===selected);
 number.title='Select and audition track '+(i+1);
 num.append(number);
 const color=document.createElement('input');
 Object.assign(color,{type:'color',value:t.color,className:'trackSwatch'});
 color.setAttribute('aria-label','Track '+(i+1)+' color');
 color.oninput=()=>{
  t.color=color.value;
  cell.style.setProperty('--track',t.color);
  grid.querySelector('[data-track-volume="'+i+'"]').style.accentColor=t.color;
  for(const step of grid.querySelectorAll('[data-step-track="'+i+'"]'))step.style.setProperty('--track',t.color);
  if(i===selected){
   $('roll').style.setProperty('--track',t.color);
   renderTrackHeading();
  }
  save('track-color-'+i);
 };
 num.append(color);
 const cell=document.createElement('div');
 cell.className='trackCell';
 cell.classList.toggle('selected',i===selected);
 cell.classList.toggle('inaudible',!isTrackAudible(t,project.tracks));
 cell.dataset.trackIndex=i;
 if(project.drumMidi.enabled)cell.title='Drum pad: '+padNoteName(project.drumMidi.notes[i])+' · channel '+(project.drumMidi.channel||'any');
 cell.style.setProperty('--track',t.color);
 function selectTrack(){
  if(selected===i)return;
  selected=i;
  clearNoteSelection();
  grid.querySelector('.trackCell.selected')?.classList.remove('selected');
  cell.classList.add('selected');
  grid.querySelector('.trackSelect[aria-pressed=true]')?.setAttribute('aria-pressed','false');
  number.setAttribute('aria-pressed','true');
  renderRoll();
  renderSound();
 }
 const fields=document.createElement('div');
 fields.className='trackFields';
 const name=document.createElement('textarea');
 Object.assign(name,{rows:1,value:t.name,maxLength:32,className:'trackName'});
 name.setAttribute('aria-label','Track '+(i+1)+' name');
 name.title='Click to rename and select this track';
 name.onfocus=selectTrack;
 name.onclick=selectTrack;
 name.oninput=()=>{
  if(name.value.includes('\n'))name.value=name.value.replaceAll('\n',' ');
  t.name=name.value.trim()||INSTRUMENTS[t.type];
  t.customName=true;
  const mute=cell.nextElementSibling,solo=mute.nextElementSibling,volume=solo.nextElementSibling;
  mute.setAttribute('aria-label','Mute '+t.name);
  mute.title='Mute '+t.name;
  solo.setAttribute('aria-label','Solo '+t.name);
  solo.title='Solo '+t.name;
  volume.setAttribute('aria-label',t.name+' volume');
  refreshRecordArms();
  for(const step of grid.querySelectorAll('[data-step-track="'+i+'"]')){
   step.setAttribute('aria-label',t.name+' step '+(+step.dataset.step+1));
  }
  if(i===selected)renderTrackHeading();
  save('track-name-'+i);
 };
 name.onblur=()=>{name.value=t.name};
 name.onkeydown=finishNameEdit;
 const instrument=document.createElement('select');
 instrument.id='instrument-'+i;
 instrument.setAttribute('aria-label','Track '+(i+1)+' instrument');
 instrument.innerHTML=instrumentOptions();
 instrument.value=DRUM_TYPES.includes(t.type)?t.kit+':'+t.type:t.type;
 instrument.onfocus=selectTrack;
 instrument.onchange=()=>{selectTrack();changeInstrument(i,instrument.value)};
 const nameRow=document.createElement('div');
 nameRow.className='trackNameRow';
 nameRow.append(name);
 if(t.type==='synth'){
  const settings=button('Synth',()=>{
   selectTrack();
   $('synthSettings').showModal();
  },'trackSynthSettings');
  settings.type='button';
  settings.title='Synth settings';
  settings.setAttribute('aria-label','Synth settings for track '+(i+1));
  settings.setAttribute('aria-haspopup','dialog');
  nameRow.append(settings);
 }
 fields.append(nameRow,instrument);
 cell.append(fields);
 const arm=button('●',()=>toggleRecordArm(i,selectTrack),'trackArm');
 arm.dataset.armTrack=i;
 grid.append(arm,num,cell);
}
function renderSteps(){$('drumKit').value=currentKit(project);let host=$('steps');host.innerHTML='';let grid=document.createElement('div');grid.className='stepgrid';['REC','#','TRACK','MUTE','SOLO','VOLUME'].forEach(text=>{let header=document.createElement('span');header.className='mixerHeader';header.textContent=text;grid.append(header)});for(let s=0;s<16;s++){let e=document.createElement('span');e.className='stepnum '+(s%4===0?'beat':'');e.textContent=String(s+1).padStart(2,'0');grid.append(e)}project.tracks.forEach((t,i)=>{renderTrackControls(grid,t,i);let mute=button('M',()=>{t.mute=!t.mute;audio.refreshMix();renderSteps();save()},'mute '+(t.mute?'muted':''));mute.title='Mute '+t.name;mute.setAttribute('aria-label','Mute '+t.name);mute.setAttribute('aria-pressed',t.mute);grid.append(mute);let solo=button('S',()=>{t.solo=!t.solo;audio.refreshMix();renderSteps();save()},'solo '+(t.solo?'active':''));solo.setAttribute('aria-label','Solo '+t.name);solo.setAttribute('aria-pressed',t.solo);solo.title='Solo '+t.name;grid.append(solo);let vol=document.createElement('input');Object.assign(vol,{type:'range',min:0,max:1,step:.01,value:t.volume,className:'vol'});vol.style.accentColor=t.color;vol.setAttribute('aria-label',t.name+' volume');vol.dataset.trackVolume=i;vol.oninput=()=>{setTrackVolume(i,+vol.value);save('volume-'+i)};grid.append(vol);let pt=pattern().parts[i];pt.steps.forEach((on,s)=>{let b=button('',async()=>{const part=pattern().parts[i];part.steps[s]=!part.steps[s];refreshStepCells();save();if(part.steps[s]&&!playing){const request=transportRequest;await audio.init(project.master);if(request!==transportRequest)return;audio.play(t,trackTriggerPitch(t.type),audio.ctx.currentTime,.15,part.velocities?.[s]??.8)}},'step '+(Math.floor(s/4)%2?'alt ':'')+(on?'on ':'')+(s===current&&playPatternId===patternId?'current':''));b.style.setProperty('--track',t.color);b.dataset.step=s;b.dataset.stepTrack=i;b.setAttribute('aria-label',t.name+' step '+(s+1));b.setAttribute('aria-pressed',on);grid.append(b)})});host.append(grid);refreshRecordArms();refreshStepCells()}
function sustainsAcross(note,boundary){
 return note.length>1&&boundary>0&&boundary<16&&note.step<boundary&&note.step+note.length>boundary+1e-6;
}
function refreshStepCells() {
  const {parts} = pattern();
  document.querySelectorAll('#steps .step').forEach((cell, index) => {
    const step = index % 16;
    const part = parts[Math.floor(index / 16)];
    const on = part.steps[step];
    cell.classList.toggle('on', on);
    cell.setAttribute('aria-pressed', on);
    const notes = part.notes.filter(note =>
      step >= Math.floor(note.step) && step < Math.ceil(note.step + note.length));
    const names = [...new Set(notes.map(note => pitchName(note.pitch).replace(/-?\d+$/, '')))];
    const label = names.join(' / ');
    cell.classList.toggle('pianoNote', names.length > 0);
    const continues=notes.some(note=>sustainsAcross(note,step+1));
    cell.classList.toggle('sustainTo',continues);
    cell.classList.toggle('sustainFrom',notes.some(note=>sustainsAcross(note,step)));
    let caption = cell.querySelector('.step-note-name');
    if (label) {
      if (!caption) {
        caption = document.createElement('span');
        caption.className = 'step-note-name';
        caption.setAttribute('aria-hidden', 'true');
        cell.append(caption);
      }
      if (caption.textContent !== label) caption.textContent = label;
    } else {
      caption?.remove();
    }
    const noteStarts = notes.filter(note => Math.floor(note.step) === step);
    const velocity = on ? (part.velocities?.[step] ?? .8)
      : noteStarts.length ? Math.max(...noteStarts.map(note => note.velocity ?? .8)) : null;
    cell.classList.toggle('hasVelocity', velocity !== null);
    cell.style.setProperty('--step-velocity', velocity === null ? '' : velocity * 100 + '%');
    const details = [];
    if (velocity !== null) details.push('Velocity ' + Math.round(velocity * 100) + '%');
    if (label) details.push('Piano roll notes: ' + label);
    if (continues) details.push('Sustains into the next step');
    if (on && noteStarts.length) details.push('Additional notes: ' + noteStarts.length);
    else if (noteStarts.length > 1) details.push(noteStarts.length + ' notes');
    cell.title = details.join(' · ');
    cell.setAttribute('aria-description', cell.title);
  });
}
function renderTrackHeading(){
 const {name,color}=track();
 for(const id of ['selectedName','fxTrackName']){
  const heading=$(id);
  heading.textContent=name;
  heading.style.setProperty('--selected-track',color);
 }
 $('fxTrackName').title=name;
}
let rollViewPart,rollTrack;
function renderRoll(){
 const host=pianoGrid,wrap=host.parentElement,old=wrap.scrollTop;
 if(rollTrack!==track()){
  releaseScreenKeys();
  rollTrack=track();
 }
 $('fullLevel').setAttribute('aria-pressed',project.fullLevel);
 host.style.setProperty('--track',track().color);
 if(!host.childElementCount){
  host.innerHTML='<span class="rollnum"></span>';
  for(let step=0;step<16;step++){
   const number=document.createElement('span');
   number.className='rollnum';
   number.textContent=step+1;
   host.append(number);
  }
  for(let pitch=84;pitch>=36;pitch--){
   const key=document.createElement('button');
   key.className=[1,3,6,8,10].includes(pitch%12)?'key black':'key';
   key.textContent=pitchName(pitch);
   wirePianoKey(key,pitch);
   pianoKeys.set(pitch,key);
   host.append(key);
   for(let step=0;step<16;step++){
    const cell=document.createElement('button');
    cell.className='note';
    cell.dataset.pitch=pitch;
    cell.dataset.step=step;
    cell.onpointerdown=event=>noteDown(event,pitch,step,cell);
    cell.onclick=event=>{
     if(event.detail===0&&(selectingNotes||pastingNotes||event.ctrlKey||event.metaKey))noteDown(event,pitch,step,cell);
    };
    cell.ondblclick=event=>{event.preventDefault();if(!selectingNotes&&!pastingNotes&&!event.ctrlKey&&!event.metaKey)deleteAt(pitch,step)};
    cell.oncontextmenu=event=>{event.preventDefault();deleteAt(pitch,step)};
    host.append(cell);
   }
  }
 }
 paintMidiKeys();
 paintNotes();
 renderTrackHeading();
 const viewPart=part();
 if(rollViewPart===viewPart){wrap.scrollTop=old;return}
 rollViewPart=viewPart;
 const pitches=viewPart.notes.map(note=>note.pitch);
 const center=pitches.length?Math.round((Math.min(...pitches)+Math.max(...pitches))/2):60;
 const cell=host.querySelector('[data-pitch="'+center+'"]');
 if(cell)wrap.scrollTop=cell.getBoundingClientRect().top-wrap.getBoundingClientRect().top+wrap.scrollTop-(wrap.clientHeight-cell.offsetHeight)/2;}
function paintNotes(){
 const notesByPitch=new Map();
 for(const note of part().notes){
  if(!notesByPitch.has(note.pitch))notesByPitch.set(note.pitch,[]);
  notesByPitch.get(note.pitch).push(note);
 }
 const covers=(note,pitch,step)=>note.pitch===pitch&&step>=Math.floor(note.step)&&step<Math.ceil(note.step+note.length);
 document.querySelectorAll('#roll .note').forEach(el=>{
  const pitch=+el.dataset.pitch,step=+el.dataset.step;
  const notes=notesByPitch.get(pitch)??[];
  const starts=notes.filter(note=>Math.floor(note.step)===step);
  const note=starts[0]??notes.find(note=>covers(note,pitch,step));
  const preview=drag?.preview;
  const ghost=preview&&covers(preview,pitch,step);
  const classes=['note'];
  if(step%4===0)classes.push('beat');
  if(note){
   classes.push(step===Math.floor(note.step)?'active':'tail');
   if(step===Math.ceil(note.step+note.length)-1)classes.push('end');
   if(selectedNotes.has(note))classes.push('chosen');
   if(drag?.moved&&note===drag.note)classes.push('dragOrigin');
  }
  if(current===step&&playPatternId===patternId)classes.push('current');
  if(ghost)classes.push('ghost');
  const shownNotes=ghost?[preview]:notes;
  const continues=shownNotes.some(note=>sustainsAcross(note,step+1));
  if(continues)classes.push('sustainTo');
  if(shownNotes.some(note=>sustainsAcross(note,step)))classes.push('sustainFrom');
  const join=el.querySelector('.sustainFill');
  if(continues&&!join){
   const fill=document.createElement('span');
   fill.className='sustainFill';
   fill.setAttribute('aria-hidden','true');
   el.append(fill);
  }else if(!continues)join?.remove();
  const className=classes.join(' ');
  if(el.className!==className)el.className=className;
  const visibleNote=ghost?preview:note;
  const opacity=visibleNote?((visibleNote.velocity??.8)*100)+'%':'';
  if(el.style.getPropertyValue('--note-opacity')!==opacity)el.style.setProperty('--note-opacity',opacity);
  const bend=visibleNote?.expression?.some(point=>point.bend!==0);
  const mod=visibleNote?.expression?.some(point=>point.mod!==0);
  const expressionLabel=[bend?'Pitch bend':'',mod?'Mod wheel':''].filter(Boolean).join(' + ');
  const badge=step===Math.floor(visibleNote?.step)?(bend?'P':'')+(mod?'M':''):'';
  if(badge)el.dataset.expression=badge;
  else if(el.dataset.expression)delete el.dataset.expression;
  const velocityLabel=visibleNote?'Velocity '+(starts.length>1&&!ghost?starts:[visibleNote]).map(hit=>Math.round((hit.velocity??.8)*100)+'%').join(', '):'';
  const details=[velocityLabel,expressionLabel,continues?'Sustains into the next step':''].filter(Boolean).join(' · ');
  const label=pitchName(pitch)+' step '+(step+1)+(visibleNote?' · '+details:' empty');
  if(el.getAttribute('aria-label')!==label)el.setAttribute('aria-label',label);
  if(el.title!==details)el.title=details;
 });
 refreshStepCells();
 updateNoteTools();
}
function findNote(p,s){const notes=part().notes;return notes.find(n=>n.pitch===p&&Math.floor(n.step)===s)??notes.find(n=>n.pitch===p&&s>=Math.floor(n.step)&&s<Math.ceil(n.step+n.length))}
function clearNoteSelection(){
 selectedNotes.clear();
 pastingNotes=false;
}
function updateNoteTools(){
 $('selectNotes').setAttribute('aria-pressed',selectingNotes);
 $('copyNotes').disabled=!selectedNotes.size;
 $('pasteNotes').disabled=!noteClipboard.length;
 $('pasteNotes').setAttribute('aria-pressed',pastingNotes);
 pianoGrid.classList.toggle('selectingNotes',selectingNotes);
 pianoGrid.classList.toggle('pastingNotes',pastingNotes);
}
$('selectNotes').onclick=()=>{
 selectingNotes=!selectingNotes;
 pastingNotes=false;
 updateNoteTools();
};
$('copyNotes').onclick=copySelectedNotes;
$('pasteNotes').onclick=beginNotePaste;
function copySelectedNotes(){
 if(!selectedNotes.size)return;
 noteClipboard=copy([...selectedNotes]);
 const first=Math.min(...noteClipboard.map(note=>note.step));
 for(const note of noteClipboard)note.step-=first;
 updateNoteTools();
 toast(noteClipboard.length+' copied. Choose Paste, then click a step.');
}
function beginNotePaste(){
 if(!noteClipboard.length)return;
 pastingNotes=!pastingNotes;
 updateNoteTools();
 if(pastingNotes)toast('Click a grid step to paste at the original pitches.');
}
function pasteNotesAt(step){
 const notes=part().notes;
 const pasted=copy(noteClipboard);
 for(const note of pasted)note.step+=step;
 if(notes.length+pasted.length>2048||pasted.some(note=>note.step+note.length>16)){
  toast('These notes do not fit here. Try an earlier step.');
  return;
 }
 if(pasted.some(note=>notes.some(existing=>existing.pitch===note.pitch
   &&Math.floor(existing.step)<Math.ceil(note.step+note.length)
   &&Math.floor(note.step)<Math.ceil(existing.step+existing.length)))){
  toast('That spot overlaps another note. Try a different step.');
  return;
 }
 clearNoteSelection();
 for(const note of pasted){
  notes.push(note);
  selectedNotes.add(note);
 }
 paintNotes();
 save();
 toast(pasted.length+' pasted.');
}
function deleteAt(pitch,step){
 const note=findNote(pitch,step);
 if(!note)return;
 part().notes=part().notes.filter(existing=>existing!==note);
 selectedNotes.delete(note);
 paintNotes();
 save();
}
function noteDown(event,pitch,step,cell){
 if(event.button!==0)return;
 event.preventDefault();
 cell.focus({preventScroll:true});
 if(pastingNotes){pasteNotesAt(step);return}
 let note=findNote(pitch,step);
 if(selectingNotes||event.ctrlKey||event.metaKey){
  if(note){
   if(selectedNotes.has(note))selectedNotes.delete(note);
   else selectedNotes.add(note);
  }
  paintNotes();
  return;
 }
 const editGroup=Symbol();
 if(!note){
  note={pitch,step,length:Math.min(+$('length').value,16-step),velocity:project.fullLevel?1:.8};
  part().notes.push(note);
  save(editGroup);
  const pressedTrack=track(),{length,velocity}=note;
  audio.init(project.master).then(()=>audio.play(pressedTrack,pitch,audio.ctx.currentTime,length*stepDur(),velocity))
   .catch(()=>toast('Audio could not start. Press Play to retry.'));
 }
 clearNoteSelection();
 selectedNotes.add(note);
 const bounds=cell.getBoundingClientRect();
 drag={note,editGroup,start:copy(note),startX:event.clientX,startY:event.clientY,startStep:step,
  resize:event.shiftKey||(step===note.step+note.length-1&&event.clientX>bounds.right-8),
  moved:false,pattern:patternId,track:selected};
 paintNotes();
}
document.addEventListener('pointermove',e=>{if(!drag)return;let cell=document.elementFromPoint(e.clientX,e.clientY)?.closest('#roll .note');if(!cell)return;if(Math.abs(e.clientX-drag.startX)+Math.abs(e.clientY-drag.startY)<5)return;drag.moved=true;let s=+cell.dataset.step,p=+cell.dataset.pitch;drag.preview=drag.resize?resizeNote(drag.start,s-drag.start.step+1):moveNote(drag.start,drag.start.step+s-drag.startStep,p);paintNotes()});
document.addEventListener('pointerup',()=>{if(!drag)return;if(drag.preview)Object.assign(drag.note,drag.preview);const {editGroup}=drag;drag=null;paintNotes();save(editGroup)});document.addEventListener('pointercancel',()=>{drag=null;paintNotes()});
const instrumentOptions=()=>Object.entries(KITS).map(([kit,info])=>'<optgroup label="'+info.name+'">'+DRUM_TYPES.map(type=>'<option value="'+kit+':'+type+'">'+info.name+' · '+INSTRUMENTS[type]+'</option>').join('')+'</optgroup>').join('')+Object.entries(INSTRUMENT_GROUPS).map(([group,types])=>'<optgroup label="'+group+'">'+types.map(k=>'<option value="'+k+'">'+INSTRUMENTS[k]+'</option>').join('')+'</optgroup>').join('');
function renderSound(){let t=track();$('soundTrack').textContent='TRACK '+String(selected+1).padStart(2,'0');$('engine').innerHTML=Object.entries(ENGINES).map(([k,name])=>'<option value="'+k+'">'+name+'</option>').join('');$('engine').value=t.engine;$('engineField').hidden=t.type!=='synth';$('preset').innerHTML='<option value="custom">Custom settings</option>'+Object.entries(PRESETS).map(([k,v])=>'<option value="'+k+'">'+v.name+'</option>').join('');$('preset').value=t.preset;$('presetField').hidden=t.type!=='synth';$('synthControls').hidden=t.type!=='synth';for(let k of ['wave','tone',...fxKeys])$(k).value=t[k];updateSoundLabels()}
function updateSoundLabels(){let t=track();$('toneValue').textContent=t.tone+' Hz';for(let key of fxKeys){let input=$(key),value=t[key];$(key+'Value').textContent=key==='pitch'?(value>0?'+':'')+value+' st':key==='delayTime'?value.toFixed(2)+' s':key==='filter'?(value?Math.round(filterCutoff(value))+' Hz':'Off'):['compressor','overdrive'].includes(key)&&!value?'Off':Math.round(value*100)+'%';input.closest('.knob').style.setProperty('--turn',(-135+(value-Number(input.min))/(Number(input.max)-Number(input.min))*270)+'deg');input.setAttribute('aria-valuetext',$(key+'Value').textContent)}}

function rememberBar(bar){
 barHistory.push(bar);
 if(barHistory.length>4)barHistory.shift();
 return bar;
}
function queueBar(time,slot,id,early){
 return rememberBar({time,slot,id,step:0,tempo:project.bpm,swing:project.swing,early});
}
function schedule(){let c=audio.ctx,limit=c.currentTime+.12;if(phase==='countin'){while(countCursor<4&&countStart+countCursor*60/countTempo<limit){let time=countStart+countCursor*60/countTempo;audio.click(time,countCursor===0,project.metronomeVolume);events.push({time,kind:'count',value:4-countCursor});countCursor++}if(countCursor===4&&cursor.time<limit){phase='playing';events.push({time:cursor.time,kind:'start'})}else return}
 let safety=0;while(cursor&&cursor.time+stepOffset(cursor.step,cursor.tempo,cursor.swing)<limit&&safety++<100){let time=cursor.time+stepOffset(cursor.step,cursor.tempo,cursor.swing),s=cursor.step,pat=project.patterns.find(p=>p.id===cursor.id);if(!pat){stop();return}let duration=60/cursor.tempo/4;playPatternStep(audio,project.tracks,pat,cursor,s,time);if(project.metronome&&s%4===0)audio.click(time,s===0,project.metronomeVolume);events.push({time,kind:'step',step:s,id:cursor.id,slot:cursor.slot,bar:cursor});cursor.step++;if(cursor.step===16){let time=cursor.time+duration*16,slot=project.mode==='song'?(cursor.slot+1)%project.song.length:0,id=project.mode==='song'?project.song[slot]:patternId;cursor=queueBar(time,slot,id)}}}
function bounceChicken(){
 if(reduceMotion.matches)return;
 $('chickenLogo').animate([{transform:'translateY(0)'},{transform:'translateY(-7px)',offset:.27},{transform:'translateY(0)'}],{duration:Math.min(250,24000/project.bpm),easing:'ease-out'});
 $('chickenBlink').animate([{opacity:0},{opacity:1,offset:.28},{opacity:1,offset:.55},{opacity:0}],{duration:140});
}
function updateSongPlayhead(){
 const active=(playing||phase==='paused')&&project.mode==='song'?songSlots.querySelector('[data-slot="'+playSlot+'"]'):null;
 for(const slot of songSlots.querySelectorAll('.songSlot'))slot.classList.toggle('playing',slot===active);
 active?.style.setProperty('--song-progress',(current+.5)/16*100+'%');
}
function animate(){if(!playing)return;while(events.length&&events[0].time<=audio.ctx.currentTime){let e=events.shift();if(e.kind==='count'){bounceChicken();danceStage.beat(4-e.value,countTempo);$('countOverlay').hidden=false;$('countNumber').textContent=e.value;$('audioStatus').textContent='● Count-in: '+e.value}else if(e.kind==='start'){$('countOverlay').hidden=true}else{if(e.step%4===0){bounceChicken();danceStage.beat(e.slot*4+e.step/4,e.bar.tempo)}current=e.step;playPatternId=e.id;playSlot=e.slot;trackTutorialPlayback(e);if(project.mode==='song'&&patternId!==e.id&&!drag)selectPattern(e.id,true);$('countOverlay').hidden=true;$('audioStatus').textContent='● Playing';$('position').textContent=String(project.mode==='song'?e.slot+1:1).padStart(2,'0')+' : '+String(e.step+1).padStart(2,'0');document.querySelectorAll('[data-step]').forEach(el=>el.classList.toggle('current',+el.dataset.step===current&&patternId===playPatternId));document.querySelectorAll('[data-pattern]').forEach(el=>el.classList.toggle('playing',el.dataset.pattern===playPatternId));updateSongPlayhead()}}animationFrame=requestAnimationFrame(animate)}
function updatePlayButtons(){
 const label=playing?'Ⅱ <span>Pause</span>':phase==='paused'?'▶ <span>Resume</span>':'▶ <span>Play</span>';
 $('play').innerHTML=label;
 $('playLower').innerHTML=label;
 $('chickenPlay').innerHTML=label;
}
let transportRequest=0,animationFrame=0,pausedSong=null;
function pauseSong(){
 const next=events.find(event=>event.kind==='step'&&event.time>audio.ctx.currentTime);
 const bar=next?.bar??cursor;
 pausedSong={...bar,step:next?.step??bar.step};
 haltPlayback();
 phase='paused';
 updatePlayButtons();
 $('audioStatus').textContent='● Paused';
}
async function play(){
 if(playing){
  if(project.mode==='song'&&playSlot>=0)pauseSong();
  else stop();
  return;
 }
 const request=++transportRequest;
 try{await audio.init(project.master)}
 catch(err){toast('Audio could not start: '+err.message);return}
 if(request!==transportRequest)return;
 playing=true;
 const resume=pausedSong;
 pausedSong=null;
 const countIn=project.countIn&&!resume;
 phase=countIn?'countin':'playing';
 countStart=audio.ctx.currentTime+.06;
 countCursor=0;
 countTempo=project.bpm;
 barHistory=[];
 if(resume){
  const offset=stepOffset(resume.step,resume.tempo,resume.swing);
  cursor=rememberBar({...resume,time:countStart-offset,firstStep:resume.step,early:.035});
 }else{
  const start=countStart+(countIn?4*60/countTempo:0);
  cursor=queueBar(start,0,project.mode==='song'?project.song[0]:patternId,countIn?.055:.035);
 }
 events=[];
 updatePlayButtons();
 schedule();
 timer=setInterval(schedule,25);
 animate();
}
function currentMidiTime(){
 const now=performance.now();
 return midiEventTime(audio.ctx,now,now);
}
function captureExpression(entry,state,time){
 if(!entry.record)return;
 const {bar,note}=entry.record;
 const start=noteOffset(note.step,bar.tempo,bar.swing);
 const elapsed=Math.max(0,(time??currentMidiTime())-entry.time);
 const offset=gridPosition(start+elapsed,bar.tempo,bar.swing)-note.step;
 recordNoteExpression(note,offset,state);
 deferMidiUi({roll:bar.id===patternId,save:true});
}
function finishHeld(entry,time){
 if(!entry.record)return;
 const {note,bar}=entry.record;
 time??=currentMidiTime();
 note.length=Math.min(16-note.step,Math.max(midiNoteLength(bar,note.step,time-entry.time),note.expression?.at(-1)?.offset??0));
 deferMidiUi({roll:bar.id===patternId,save:true});
}
function haltPlayback(){
 if(tutorial)tutorial.heardBars=0;
 transportRequest++;
 releaseScreenKeys();
 playing=false;
 clearInterval(timer);
 cancelAnimationFrame(animationFrame);
 events=[];
 cursor=null;
 for(const entry of liveNotes.values())finishHeld(entry);
 liveNotes.clear();
 paintMidiKeys();
 pedals.clear();
 audio.stop();
 pulseQueue=[];
 activeGlows.clear();
 $('noteAtmosphere').replaceChildren();
 $('countOverlay').hidden=true;
}
function stop(){
 haltPlayback();
 phase='stopped';
 pausedSong=null;
 current=-1;
 playPatternId=null;
 playSlot=-1;
 updatePlayButtons();
 $('audioStatus').textContent='● Ready to play';
 $('position').textContent='01 : 01';
 document.querySelectorAll('.current,.playing').forEach(el=>el.classList.remove('current','playing'));
}
function makeSongBarUnique(index){
 if(project.patterns.length>=64)return;
 const source=project.patterns.find(p=>p.id===project.song[index]);
 if(!source)return;
 stop();
 const names=new Set(project.patterns.map(p=>p.name.trim().toLowerCase()));
 let number=1;
 while(names.has('pattern '+number))number++;
 const variation=copy(source);
 const baseId='p'+Date.now().toString(36);
 const ids=new Set(project.patterns.map(p=>p.id));
 variation.id=baseId;
 for(let suffix=1;ids.has(variation.id);suffix++)variation.id=baseId+'-'+suffix;
 variation.name='Pattern '+number;
 variation.color=takePatternColor(project);
 project.patterns.push(variation);
 project.song[index]=variation.id;
 selectPattern(variation.id);
 save();
 songSlots.children[index]?.firstElementChild.focus({preventScroll:true});
}
function newPattern(duplicate=false){if(project.patterns.length>=64){toast('Maximum 64 patterns per project.');return}let id='p'+Date.now().toString(36),p=duplicate?copy(pattern()):emptyPattern(id,'Pattern '+(project.patterns.length+1));p.id=id;p.color=takePatternColor(project);p.name=duplicate?pattern().name+' copy':p.name;project.patterns.push(p);selectPattern(id);save()}
for(const id of ['patternName','patternColor']){
 const field=$(id);
 field.onfocus=()=>{field.editingPattern=pattern()};
 field.onblur=()=>{field.editingPattern=null;refreshPatternSelection()};
}
$('addPattern').onclick=()=>newPattern();$('duplicatePattern').onclick=()=>newPattern(true);$('patternName').oninput=()=>{let p=$('patternName').editingPattern||pattern();p.name=$('patternName').value||'Pattern';renderPatternHeading();document.querySelectorAll('[data-pattern]').forEach(el=>{if(el.dataset.pattern===p.id)el.textContent=p.name});document.querySelectorAll('[data-slot]').forEach(el=>{let i=+el.dataset.slot;if(project.song[i]===p.id)el.firstElementChild.textContent=String(i+1).padStart(2,'0')+' · '+p.name});save()};trash.onclick=()=>deletePattern(patternId);$('patternColor').oninput=()=>{let p=$('patternColor').editingPattern||pattern();p.color=$('patternColor').value;renderPatternHeading();document.querySelectorAll('[data-pattern]').forEach(el=>{if(el.dataset.pattern===p.id)el.style.setProperty('--pattern',p.color)});document.querySelectorAll('[data-slot]').forEach(el=>{if(project.song[+el.dataset.slot]===p.id)el.style.setProperty('--pattern',p.color)});save()};$('makePatternUnique').onclick=()=>makeSongBarUnique(selectedSongSlot);
$('patternMode').onclick=()=>setMode('pattern');$('songMode').onclick=()=>setMode('song');function setMode(mode){stop();project.mode=mode;renderTransport();save()}
function panic(){
 stop();
 midiExpression.clear();
 studioExpression.bend=0;
 studioExpression.mod=0;
 displayExpression(studioExpression);
 toast('All sounds stopped.');
}
$('panic').onclick=panic;
$('play').onclick=play;$('stop').onclick=stop;
['countIn','metronome'].forEach(k=>$(k).onclick=()=>{project[k]=!project[k];if(k==='countIn'&&project.countIn)project.metronome=true;renderTransport();save()});$('bpm').onchange=()=>{setTempo($('bpm').value);commitTempo()};
function setTempo(value){
 project.bpm=Math.round(clamp(value,40,240,112));
 $('bpm').value=project.bpm;
}
function commitTempo(){
 save();
 if(playing)toast('New tempo begins at the next bar.');
}
$('tempoUp').onclick=()=>{setTempo(project.bpm+1);commitTempo()};
$('tempoDown').onclick=()=>{setTempo(project.bpm-1);commitTempo()};
for(const handle of [$('tempoDrag'),$('bpm')]){
 let dragTempo, suppressClick=false;
 handle.onpointerdown=e=>{
  if(e.button!==0)return;
  suppressClick=false;
  dragTempo={id:e.pointerId,y:e.clientY,bpm:project.bpm};
 };
 handle.onpointermove=e=>{
  if(dragTempo?.id!==e.pointerId)return;
  const delta=Math.trunc((dragTempo.y-e.clientY)/4);
  if(!delta&&!suppressClick)return;
  if(!suppressClick){handle.setPointerCapture(e.pointerId);suppressClick=true}
  setTempo(dragTempo.bpm+delta);
 };
 const end=e=>{
  if(dragTempo?.id!==e.pointerId)return;
  if(suppressClick)commitTempo();
  dragTempo=null;
 };
 handle.onpointerup=end;
 handle.onpointercancel=end;
 handle.onlostpointercapture=end;
 handle.onpointerleave=e=>{if(!suppressClick)end(e)};
 handle.onclick=e=>{if(suppressClick){e.preventDefault();suppressClick=false}};
}
$('swing').oninput=()=>{project.swing=+$('swing').value/100;$('swingValue').textContent=$('swing').value+'%';save('swing')};$('swing').onchange=()=>{if(playing)toast('New swing begins at the next bar.')};$('master').oninput=()=>{setMasterVolume(+$('master').value);save('master')};function finishNameEdit(event){
 if(event.key==='Enter'&&!event.isComposing){
  event.preventDefault();
  event.currentTarget.blur();
 }
}
$('title').onkeydown=finishNameEdit;
$('title').oninput=()=>{
 const title=$('title');
 if(title.value.includes('\n'))title.value=title.value.replaceAll('\n',' ');
 project.title=title.value;
 save('title');
};
function changeInstrument(i,choice){let t=project.tracks[i],old=INSTRUMENTS[t.type];if(choice.includes(':')){[t.kit,t.type]=choice.split(':')}else t.type=choice;Object.assign(t,MODELED_INSTRUMENTS[t.type]?.envelope||ENVELOPES[t.type]);if(t.type==='synth'){let {name,...settings}=PRESETS.warm;Object.assign(t,settings);t.preset='warm'}if(!t.customName&&(t.name===old||t.name==='Synth'||t.name.startsWith('Track ')))t.name=INSTRUMENTS[t.type];renderSound();renderSteps();audio.prepareTrack(t).catch(()=>{});renderTrackHeading();save();$('instrument-'+i).focus({preventScroll:true})}
$('preset').onchange=()=>{let t=track();t.preset=$('preset').value;if(t.preset==='custom'){save();return}let {name,...settings}=PRESETS[t.preset];Object.assign(t,settings);renderSound();save()};['wave','tone'].forEach(k=>$(k).oninput=()=>{track()[k]=k==='wave'?$(k).value:+$(k).value;track().preset='custom';$('preset').value='custom';updateSoundLabels();save('sound-'+k+'-'+selected)});
async function auditionTrack(t){const request=transportRequest;await audio.init(project.master);if(request!==transportRequest)return;let voice=audio.play(t,trackTriggerPitch(t.type),audio.ctx.currentTime,.65,.8,true,studioExpression);if(voice){screenVoices.add(voice);setTimeout(()=>{voice.release();screenVoices.delete(voice)},650)}}

$('fullLevel').onclick=()=>{
 project.fullLevel=!project.fullLevel;
 $('fullLevel').setAttribute('aria-pressed',project.fullLevel);
 save();
};
$('clearNotes').onclick=()=>{part().notes=[];clearNoteSelection();paintNotes();save()};$('clear').onclick=()=>{
 const target=pattern();
 $('clearPatternWarning').textContent='Clear all steps and notes in '+target.name+'?';
 $('confirmClearPattern').onclick=()=>{
  $('clearPatternDialog').close();
  target.parts.forEach(part=>{part.steps.fill(false);part.notes=[]});
  clearNoteSelection();
  renderSteps();
  paintNotes();
  save();
 };
 $('clearPatternDialog').showModal();
};
function loadProject(next,trackIndex=selected,commit=true){
 const oldPattern=patternId;
 if(commit){
  stop();
  drumsArmed=false;
  armedInstrument=null;
 }
 if(tutorial&&(commit||!next.patterns.some(pattern=>pattern.id===tutorialPatternId)))closeTutorial();
 project=next;
 $('patternName').editingPattern=null;
 $('patternColor').editingPattern=null;
 selectedSongSlot=-1;
 selected=trackIndex;
 patternId=!commit&&project.patterns.some(pattern=>pattern.id===oldPattern)?oldPattern:project.patterns[0].id;
 clearNoteSelection();
 drag=null;
 render();
 audio.volume(project.master);
 audio.prepareTracks(project.tracks).catch(()=>{});
 if(commit)save();
}
function downloadProject(){
 const url=URL.createObjectURL(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}));
 const link=document.createElement('a');
 link.href=url;
 link.download=(project.title.replace(/[^a-z0-9_-]/gi,'-')||'looplab')+'.json';
 link.click();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export').onclick=downloadProject;
function encodeSong(buffer){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./mp3-worker.js',import.meta.url));
  worker.onmessage=({data})=>{
   worker.terminate();
   if(data.error)reject(new Error(data.error));
   else resolve(data.blob);
  };
  worker.onerror=()=>{
   worker.terminate();
   reject(new Error('MP3 encoder could not start.'));
  };
  const left=buffer.getChannelData(0).slice(),right=buffer.getChannelData(1).slice();
  worker.postMessage({left,right,sampleRate:buffer.sampleRate},[left.buffer,right.buffer]);
 });
}
$('exportSong').onclick=()=>{
 $('exportSongName').value=project.title;
 $('exportSongDialog').showModal();
 $('exportSongName').select();
};
$('cancelSongExport').onclick=()=>$('exportSongDialog').close();
$('exportSongForm').onsubmit=async event=>{
 event.preventDefault();
 const name=$('exportSongName').value.trim();
 if(!name){$('exportSongName').focus();return}
 const snapshot=copy(project);
 const button=$('exportSong');
 $('exportSongDialog').close();
 button.disabled=true;
 button.lastElementChild.textContent='Rendering MP3…';
 try{
  const blob=await encodeSong(await renderSong(snapshot));
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;
  link.download=(name.replace(/[<>:"/\\|?*]/g,'-').replace(/[. ]+$/,'')||'looplab')+'.mp3';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
  toast('MP3 exported.');
 }catch(error){toast('Export failed. '+error.message)}
 finally{button.disabled=false;button.lastElementChild.textContent='EXPORT'}
};

function confirmProjectReplacement(title, warning, actionLabel, replaceProject){
 $('newProjectSaveTitle').textContent=title;
 $('newProjectConfirmWarning').textContent=warning;
 $('confirmNewProject').textContent=actionLabel;
 $('confirmNewProject').onclick=()=>{
  $('newProjectConfirm').close();
  replaceProject();
 };
 $('newProjectSave').showModal();
}
const tutorialPatternId='tutorial-a';
const tutorialSteps=[
 ['Make a variation','Pattern A already has a beat. Click Duplicate, rename the copy B in the pattern name field, then change at least one drum hit on steps 13–16.'],
 ['Arrange your song','Song Order already starts with A. Drag A, then B, then A from the Patterns row into the highlighted Song Order strip. Drop each one after the last bar. When it reads A–A–B–A, click Song, then Check step.'],
 ['Hear the loop','Click Play and let all four bars play until the playhead returns to bar 1. Then click Check step.'],
 ['Challenge complete!','You made a song! For a hidden dance party, try clicking the chicken sticker in the top-left corner while your song plays.']
];
let tutorial=null;
function startTutorial(){
 const starter=freshProject();
 starter.title='First Beat Challenge';
 starter.patterns=[emptyPattern(tutorialPatternId,'A')];
 starter.song=[tutorialPatternId];
 const beat=[[0,8],[4,12],[0,2,4,6,8,10,12,14]];
 beat.forEach((hits,track)=>hits.forEach(step=>{starter.patterns[0].parts[track].steps[step]=true}));
 loadProject(starter,0);
 tutorial={step:0,bId:null,heardBars:0,looped:false,beat};
 showTutorialStep();
 document.querySelector('.arrangement').scrollIntoView({block:'start'});
}
function closeTutorial(){
 tutorial=null;
 $('tutorialCard').hidden=true;
}
function showTutorialStep(){
 const {step}=tutorial;
 const [title,instruction]=tutorialSteps[step];
 const complete=step===tutorialSteps.length-1;
 $('tutorialCard').hidden=false;
 $('tutorialCard').dataset.step=step;
 $('tutorialProgress').textContent=complete?'FIRST BEAT CHALLENGE':'FIRST BEAT CHALLENGE · '+(step+1)+' / 3';
 $('tutorialTitle').textContent=title;
 $('tutorialInstruction').textContent=instruction;
 $('tutorialFeedback').textContent='';
 $('checkTutorial').textContent=complete?'Done':'Check step';
}
function tutorialVariation(){
 const original=project.patterns.find(pattern=>pattern.id===tutorialPatternId);
 const variation=project.patterns.find(pattern=>pattern.id!==tutorialPatternId&&pattern.name.trim().toUpperCase()==='B');
 if(!original||!variation)return null;
 const drums=original.parts.slice(0,4);
 const originalBeatIntact=drums.every((part,track)=>part.steps.every((hit,step)=>
  hit===(tutorial.beat[track]?.includes(step)??false)));
 const lastBeatChanged=drums.some((part,track)=>part.steps.slice(12).some((hit,index)=>
  hit!==variation.parts[track].steps[12+index]));
 const firstThreeBeatsMatch=drums.every((part,track)=>part.steps.slice(0,12).every((hit,step)=>
  hit===variation.parts[track].steps[step]));
 return originalBeatIntact&&firstThreeBeatsMatch&&lastBeatChanged?variation:null;
}
function tutorialOrderMatches(){
 const order=[tutorialPatternId,tutorialPatternId,tutorial.bId,tutorialPatternId];
 return project.mode==='song'&&project.song.length===order.length
  &&project.song.every((id,index)=>id===order[index]);
}
function trackTutorialPlayback(event){
 if(tutorial?.step!==2||tutorial.looped||event.step!==0)return;
 if(!tutorialOrderMatches()||!tutorialVariation()){tutorial.heardBars=0;return}
 if(event.slot===0&&tutorial.heardBars===4){tutorial.looped=true;return}
 tutorial.heardBars=event.slot===tutorial.heardBars?tutorial.heardBars+1:Number(event.slot===0);
}
$('checkTutorial').onclick=()=>{
 if(!tutorial)return;
 if(tutorial.step===3){closeTutorial();return}
 const variation=tutorialVariation();
 if(!variation){
  if(tutorial.step!==0){tutorial.step=0;showTutorialStep()}
  $('tutorialFeedback').textContent='Keep A as it started. B should match it through step 12 and change a drum hit on steps 13–16.';
  return;
 }
 tutorial.bId=variation.id;
 if(tutorial.step>=1&&!tutorialOrderMatches()){
  if(tutorial.step!==1){tutorial.step=1;showTutorialStep()}
  $('tutorialFeedback').textContent='Song mode needs exactly four bars in this order: A–A–B–A.';
  return;
 }
 if(tutorial.step===2&&!tutorial.looped){
  $('tutorialFeedback').textContent='Let the four bars play all the way back to bar 1, then check again.';
  return;
 }
 tutorial.step++;
 tutorial.heardBars=0;
 tutorial.looped=false;
 showTutorialStep();
};
$('leaveTutorial').onclick=closeTutorial;
$('startTutorial').onclick=()=>{
 $('guide').close();
 confirmProjectReplacement('Start the First Beat Challenge?',
  'This loads a starter beat in place of your current project.',
  'Yes, start tutorial',startTutorial);
};
$('newProject').onclick=()=>confirmProjectReplacement(
 'Start a new project?', 'Are you sure you want to replace this session with a blank project?',
 'Yes, start fresh', ()=>{
  loadProject(freshProject(),4);
  toast('New project ready.');
 }
);
$('demo').onclick=()=>confirmProjectReplacement(
 'Load the demo song?', `Are you sure you want to replace this session with ${DEMO_TITLE}?`,
 'Yes, load the demo', ()=>{
  loadProject(demoProject(),5);
  toast(`${DEMO_TITLE} loaded. Press Play.`);
 }
);
$('cancelNew').onclick=()=>$('newProjectSave').close();
function showChickenConfirmation(){
 $('newProjectSave').close();
 $('newProjectConfirm').showModal();
}
$('saveBeforeNew').onclick=()=>{
 downloadProject();
 showChickenConfirmation();
};
$('skipSaveBeforeNew').onclick=showChickenConfirmation;
$('keepCurrentProject').onclick=()=>$('newProjectConfirm').close();
$('import').onclick=()=>$('file').click();
$('file').onchange=async e=>{
 try{
  const file=e.target.files[0];
  if(!file)return;
  if(file.size>5e6)throw Error('Project file is too large.');
  const raw=JSON.parse(await file.text());
  loadProject(normalize(raw));
  toast(Array.isArray(raw.song)&&raw.song.length>MAX_SONG_BARS?'Opened the first 16 song bars. All patterns are available.':'Project opened');
 }catch(err){toast(err.message||'Could not open project.')}
 finally{e.target.value=''}
};
const danceStage=createDanceStage($('chickenEgg'));
$('chickenButton').onclick=()=>{updatePlayButtons();$('chickenEgg').showModal();danceStage.reset()};
$('chickenPlay').onclick=play;
$('chickenStop').onclick=stop;
$('help').onclick=()=>$('guide').showModal();
$('closeGuide').onclick=()=>$('guide').close();
document.addEventListener('keydown',event=>{
 if(document.querySelector('dialog[open]'))return;
 if(event.key==='Escape'){
  if(pastingNotes){pastingNotes=false;updateNoteTools()}
  else panic();
  return;
 }
 if(['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName))return;
 if(event.metaKey||event.ctrlKey){
  const key=event.key.toLowerCase();
  if(key==='z'||key==='y'){
   event.preventDefault();
   $(event.shiftKey||key==='y'?'redo':'undo').click();
   return;
  }
  if(key==='c'&&selectedNotes.size&&!getSelection()?.toString()){
   event.preventDefault();
   copySelectedNotes();
   return;
  }
  if(key==='v'&&noteClipboard.length){
   event.preventDefault();
   beginNotePaste();
   return;
  }
 }
 if(event.code==='Space'&&event.target.tagName!=='BUTTON'){
  event.preventDefault();
  play();
 }
 if((event.key==='Delete'||event.key==='Backspace')&&selectedNotes.size){
  event.preventDefault();
  part().notes=part().notes.filter(note=>!selectedNotes.has(note));
  clearNoteSelection();
  paintNotes();
  save();
 }
});
function setMasterVolume(value){
 project.master=value;
 $('master').value=value;
 audio.volume(value);
}
function setTrackVolume(index,value){
 const track=project.tracks[index];
 track.volume=value;
 audio.setTrackVolume(track);
 const slider=document.querySelector('[data-track-volume="'+index+'"]');
 if(slider)slider.value=value;
}
function policyAllowed(){let policy=document.permissionsPolicy||document.featurePolicy;try{return policy?.allowsFeature('midi')??null}catch{return null}}
function midiInfo(message){$('midiDiagnostic').textContent=message;$('midiDetails').textContent=JSON.stringify({secureContext:window.isSecureContext,embedded:window.self!==window.top,apiAvailable:!!navigator.requestMIDIAccess,midiAllowedByPagePolicy:policyAllowed(),permission:midiPermission,audioState:audio.ctx?.state||'not started',latencyHint:'interactive',estimatedOutputBufferMs:audio.ctx?Math.round(((audio.ctx.baseLatency||0)+(audio.ctx.outputLatency||0))*1000):null,inputs:midiAccess?[...midiAccess.inputs.values()].map(i=>({name:i.name,state:i.state,connection:i.connection})):[]},null,2)}
async function connectMidi(){if(!window.isSecureContext){midiInfo('MIDI needs a secure page. Open the published HTTPS studio in desktop Chrome.');return}if(!navigator.requestMIDIAccess){midiInfo('This browser does not expose Web MIDI. Use desktop Chrome on your own computer.');return}if(policyAllowed()===false){midiInfo('MIDI is blocked by this page’s Permissions Policy, so Chrome cannot show a prompt. Open the studio directly in its own Chrome tab. If it remains blocked, the hosting or device policy must allow MIDI.');return}
 if(connectingMidi)return;
 if(midiAccess){
  audio.init(project.master).catch(()=>{});
  attachMidi();
  return;
 }
 connectingMidi=true;
 $('retryMidi').disabled=true;
 try{let promise=navigator.requestMIDIAccess({sysex:false});midiInfo('Waiting for Chrome’s MIDI permission. Check the address bar for a permission request.');audio.init(project.master).catch(()=>{});
 midiAccess=await promise;midiPermission='granted';
 midiAccess.onstatechange=({port})=>{
  if(port.type!=='input')return;
  if(port.state==='disconnected')releaseMidiChannels(channel=>channel.startsWith(port.id+':'));
  attachMidi();
 };
 attachMidi()}catch(err){try{midiPermission=(await navigator.permissions.query({name:'midi',sysex:false})).state}catch{}let detail=err.name+': '+err.message;let message=err.name==='NotAllowedError'||err.name==='SecurityError'?'Chrome or the system denied MIDI access. This can happen without a prompt in a preview, after a saved denial, or on a managed device. Open this studio in a regular Chrome tab, check its MIDI site permission, and retry.':'MIDI could not initialize: '+detail;midiInfo(message);$('midiDetails').textContent+='\nBrowser error: '+detail}finally{connectingMidi=false;$('retryMidi').disabled=false}}
function releaseMidiChannels(matches){
 for(const [key,entry] of liveNotes)if(matches(entry.channel)){
  entry.voice?.release();
  finishHeld(entry);
  liveNotes.delete(key);
 }
 paintMidiKeys();
 for(const channel of pedals)if(matches(channel))pedals.delete(channel);
 for(const channel of midiExpression.keys())if(matches(channel))midiExpression.delete(channel);
}
function releaseAllMidi(){releaseMidiChannels(()=>true);displayExpression(studioExpression)}
const midiActivity=[];
let activityFrame=0;
function monitorMidi(input,event,label){
 if(input.id==='pad-preview')return;
 const time=(event.timeStamp/1000).toFixed(3);
 midiActivity.unshift(time+'s · '+(input.name||'Unnamed MIDI input')+' · '+label);
 if(midiActivity.length>8)midiActivity.pop();
 if(!activityFrame)activityFrame=requestAnimationFrame(()=>{
  activityFrame=0;
  $('midiActivity').textContent=midiActivity.join('\n');
 });
}
const midiListeners=new Map();
let midiLightTimer;
function showMidiSignal(recognized){
 const light=$('midiLight');
 light.dataset.signal=recognized?'recognized':'received';
 light.title=recognized?'MIDI message recognized':'MIDI received · no action assigned';
 clearTimeout(midiLightTimer);
 midiLightTimer=setTimeout(()=>{
  delete light.dataset.signal;
  light.title='MIDI activity · waiting for input';
 },220);
}
function attachMidi(){
 const inputs=[...midiAccess.inputs.values()].filter(input=>input.state==='connected');
 const menu=$('midiInput');
 menu.replaceChildren(new Option('All inputs',''),...inputs.map(input=>new Option(input.name||'Unnamed MIDI input',input.id)));
 const selectedPort=inputs.find(input=>input.id===selectedMidiInput);
 if(selectedMidiInput&&!selectedPort)menu.add(new Option('Selected input disconnected',selectedMidiInput));
 menu.value=selectedMidiInput;
 const active=selectedMidiInput?(selectedPort?[selectedPort]:[]):inputs;
 for(const [id,input] of midiListeners)if(!active.includes(input)){
  input.onmidimessage=null;
  midiListeners.delete(id);
  releaseMidiChannels(channel=>channel.startsWith(id+':'));
 }
 for(const input of active)if(!midiListeners.has(input.id)){
  input.onmidimessage=event=>handleMidi(input,event,true);
  midiListeners.set(input.id,input);
 }
 $('midiButtonLabel').textContent=active.length?'MIDI connected':'Connect MIDI';
 $('retryMidi').textContent='Refresh MIDI inputs';
 midiInfo(selectedMidiInput
  ? selectedPort?'Listening to '+(selectedPort.name||'the selected input')+'.':'Selected input disconnected. Reconnect it or choose another input.'
  : inputs.length?'Listening to all '+inputs.length+' MIDI '+(inputs.length===1?'input.':'inputs.')
  :'Chrome granted MIDI access, but found no inputs. Connect a controller or check Audio MIDI Setup on your Mac.');
}
$('midiInput').onchange=event=>{
 selectedMidiInput=event.target.value;
 if(midiAccess)attachMidi();
};
function handleMidi(input,event,hardware=false){
 const [status,p,v]=event.data,kind=status&240,midiChannel=(status&15)+1;
 const channel=input.id+':'+(status&15),key=channel+':'+p;
 const miniLab=!hardware||isMiniLabInput(input.name);
 const mixerTarget=kind===176&&miniLab?miniLabMixerTarget(p):null;
 const noteOn=kind===144&&v>0,noteOff=kind===128||(kind===144&&v===0);
 const velocity=v/127;
 const receivedAt=performance.now();
 const inputTime=audio.ctx?midiEventTime(audio.ctx,event.timeStamp,receivedAt):0;
 const isBend=kind===224,isMod=kind===176&&p===1;
 const mapping=project.drumMidi;
 const route=noteOn?routeMidiNote(!miniLab&&mapping.preset==='minilab'?{...mapping,enabled:false}:mapping,midiChannel,p,armedInstrument??selected,project.tracks):null;
 if(hardware&&status>=128&&status<240){
  showMidiSignal(!!(route||noteOff||isBend||isMod||mixerTarget!==null||
   (noteOn&&padLearning>=0)||(kind===176&&[64,120,123].includes(p))));
 }
 if(noteOn||noteOff){
  const action=noteOn?'Note on':'Note off';
  const routedTrack=route&&project.tracks[route.track];
  const target=noteOn?(routedTrack?' → '+routedTrack.name+(!audio.isAudible(routedTrack)?' · muted by mixer':routedTrack.volume===0?' · volume 0':audio.ctx?.state!=='running'?' · audio paused':''):' · outside pad mapping'):'';
  monitorMidi(input,event,'CH '+midiChannel+' · '+action+' · '+padNoteName(p)+(noteOn?' · velocity '+v+'/127 ('+Math.round(velocity*100)+'%)':'')+target);
 }else if(isBend||isMod){
  monitorMidi(input,event,'CH '+midiChannel+' · '+(isBend?'Pitch bend '+((v<<7)|p):'Mod wheel '+v));
 }else if(hardware&&kind===176&&mixerTarget===null){
  monitorMidi(input,event,'CH '+midiChannel+' · CC '+p+' · '+v);
 }
 if(mixerTarget!==null){
  const volume=Math.round(v/127*100)/100;
  if(mixerTarget==='master')setMasterVolume(volume);
  else setTrackVolume(mixerTarget,volume);
  const label=mixerTarget==='master'?'Fader 4 → master':'Knob '+(mixerTarget+1)+' → track '+(mixerTarget+1);
  monitorMidi(input,event,label+' · '+Math.round(volume*100)+'%');
  deferMidiUi({save:true});
  return;
 }
 if(isBend||isMod){
  const state={...(midiExpression.get(channel)||studioExpression)};
  if(isBend){const bend=((v<<7)|p)-8192;state.bend=bend/(bend<0?8192:8191)}
  else state.mod=v/127;
  midiExpression.set(channel,state);
  for(const entry of liveNotes.values())if(entry.channel===channel&&!entry.pad){
   entry.voice?.express(state);
   captureExpression(entry,state,inputTime);
  }
  displayExpression(state);
  return;
 }
 if(kind===144&&v>0&&padLearning>=0){let target=padLearning;learnDrumNote(project.drumMidi,target,p,midiChannel);padLearning=-1;renderDrumMidi();renderSteps();save();$('lastMidi').textContent='Learned '+padNoteName(p)+' on channel '+midiChannel+' → '+project.tracks[target].name;if(audio.ctx)audio.play(project.tracks[target],DRUM_TYPES.includes(project.tracks[target].type)?60:p,audio.ctx.currentTime,.2,velocity);return}if(!audio.ctx)return;if(audio.ctx.state==='suspended')audio.ctx.resume().catch(()=>{});let now=audio.ctx.currentTime;
 if(noteOn){
  if(!route)return;
  const targetTrack=project.tracks[route.track],previous=liveNotes.get(key);
  if(previous){previous.voice?.release();finishHeld(previous,inputTime)}
  const expression=route.pad?undefined:midiExpression.get(channel)||studioExpression;
  const voice=audio.play(targetTrack,route.pitch,now,.3,velocity,true,expression);
  const entry={voice,track:targetTrack,pitch:route.pitch,time:inputTime,channel,pad:route.pad,released:false};
  if(expression)displayExpression(expression);
  deferMidiUi({message:(hardware?'Note on':'Pad preview')+' · CH '+midiChannel+' · '+padNoteName(p)+' → '+targetTrack.name+' · Velocity '+v+'/127 ('+Math.round(velocity*100)+'%)'});
  if(playing&&isTrackArmed(route.track)){
   const quantized=project.midiQuantize;
   const position=midiRecordPosition(barHistory,inputTime,quantized);
   const targetPattern=position&&project.patterns.find(pattern=>pattern.id===position.bar.id);
   if(targetPattern){
    if(route.pitch>=36&&route.pitch<=84){
     const note=writeMidiHit(targetPattern.parts[route.track],{...position,pitch:route.pitch,time:inputTime,velocity,pad:route.pad,quantized});
     if(note&&!route.pad){
      entry.record={bar:position.bar,note};
      if(expression.bend||expression.mod)recordNoteExpression(note,0,expression);
     }
     deferMidiUi({roll:!!note&&targetPattern.id===patternId,steps:!note&&targetPattern.id===patternId,save:true});
    }else toast('Recording range is C2–C6; this note can still be played live.');
   }
  }
  liveNotes.set(key,entry);
  paintMidiKeys();
 }else if(noteOff){
  const entry=liveNotes.get(key);
  if(!entry)return;
  if(pedals.has(channel))entry.released=true;
  else{entry.voice?.release();liveNotes.delete(key)}
  finishHeld(entry,inputTime);
  entry.record=null;
  paintMidiKeys();
 }else if(kind===176&&p===64){
  if(v>=64)pedals.add(channel);
  else{
   pedals.delete(channel);
   for(const [key,entry] of liveNotes)if(entry.channel===channel&&entry.released){
    entry.voice?.release();
    liveNotes.delete(key);
   }
  }
 }else if(kind===176&&(p===123||p===120))releaseMidiChannels(key=>key===channel);
}

$('midi').onclick=()=>{if(!$('midiDialog').open)$('midiDialog').showModal();if(!midiAccess||!midiListeners.size)connectMidi()};$('retryMidi').onclick=connectMidi;$('closeMidi').onclick=()=>$('midiDialog').close();$('standalone').href='https://looproom-music-lab.alikecrocus1.chatgpt.site/';
const padNoteName=p=>['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][p%12]+(Math.floor(p/12)-2)+' / '+p;
function renderDrumMidi(){let m=project.drumMidi;$('drumMidiPreset').value=m.enabled?m.preset:'off';$('drumMidiChannel').value=m.channel;$('padSettings').textContent='⌁ Drum pads · '+(m.enabled?'CH '+(m.channel||'Any'):'Off');let host=$('drumMidiPads');host.innerHTML='';m.notes.forEach((note,i)=>{let card=document.createElement('div');card.className='padCard';card.style.setProperty('--track',project.tracks[i].color);let title=document.createElement('strong');title.textContent=project.tracks[i].name;let triggerPad=async()=>{const request=transportRequest;await audio.init(project.master);if(request!==transportRequest)return;let id='pad-preview',channel=m.channel||10;handleMidi({id},{data:[0x90+channel-1,note,100]});setTimeout(()=>handleMidi({id},{data:[0x80+channel-1,note,0]}),90)};let play=button('▶ '+padNoteName(note),()=>{},'padPlay');play.onclick=e=>{if(e.detail===0)triggerPad()};play.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();play.focus();triggerPad()};play.onkeydown=e=>{if(e.code==='Space'||e.code==='Enter'){e.preventDefault();e.stopPropagation();if(!e.repeat)triggerPad()}};play.onkeyup=e=>{if(e.code==='Space'||e.code==='Enter'){e.preventDefault();e.stopPropagation()}};play.setAttribute('aria-label','Play drum pad '+(i+1));let field=document.createElement('input');Object.assign(field,{type:'number',min:0,max:127,step:1,value:note});field.setAttribute('aria-label','Drum pad '+(i+1)+' note');field.onchange=()=>{learnDrumNote(m,i,Math.round(clamp(field.value,0,127,note)),m.channel);renderDrumMidi();save()};let learn=button(padLearning===i?'Listening…':'Learn',()=>{padLearning=padLearning===i?-1:i;renderDrumMidi();$('lastMidi').textContent=padLearning<0?'Learning cancelled.':'Hit a hardware pad to map track '+(i+1)+'.'},'padLearn');learn.setAttribute('aria-label','Learn drum pad '+(i+1));learn.setAttribute('aria-pressed',padLearning===i);card.append(title,play,field,learn);host.append(card)})}
$('drumMidiChannel').innerHTML='<option value="0">Any</option>'+Array.from({length:16},(_,i)=>'<option value="'+(i+1)+'">'+(i+1)+'</option>').join('');
$('drumMidiChannel').onchange=()=>{releaseAllMidi();project.drumMidi.channel=+$('drumMidiChannel').value;renderDrumMidi();save()};
$('drumMidiPreset').onchange=()=>{releaseAllMidi();padLearning=-1;let choice=$('drumMidiPreset').value;if(choice==='off')project.drumMidi.enabled=false;else if(choice==='custom'){project.drumMidi.enabled=true;project.drumMidi.preset='custom'}else project.drumMidi=drumMidiPreset(choice);renderDrumMidi();save()};
$('padSettings').onclick=()=>{renderDrumMidi();$('padAdvanced').open=true;$('midiDialog').showModal()};$('midiDialog').addEventListener('close',()=>{
 if(padLearning>=0)$('lastMidi').textContent='Learning cancelled.';
 padLearning=-1;
 renderDrumMidi();
});
$('metronomeVolume').oninput=()=>{project.metronomeVolume=+$('metronomeVolume').value/100;$('metronomeVolumeValue').textContent=$('metronomeVolume').value+'%';save('click-volume')};
$('midiQuantize').onclick=()=>{project.midiQuantize=!project.midiQuantize;renderTransport();save();toast(project.midiQuantize?'MIDI note starts snap to the swung 1/16 grid. Fast repeats keep their spacing.':'New MIDI recordings preserve your timing. Live playing stays immediate.')};
let pulseQueue=[],pulseFrame=false;
const activeGlows=new Map();
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
// Width, height, angle and edge softness give each instrument its own silhouette.
const glowProfiles={
 kick:[1.02,.95,0,57],snare:[1.14,.44,-17,65],closed:[.43,.28,24,63],open:[.63,.39,20,76],
 crash:[1.4,.76,-27,82],clap:[.84,.52,16,56],tom:[.84,.76,0,63],
 bass:[1.12,.56,0,72],pbass:[1.28,.62,-8,66],piano:[.84,.94,0,68],epiano:[.96,.69,14,76],
 organ:[1.25,.78,0,82],strings:[1.48,.64,-13,86],flute:[.59,1.01,25,80],
 aguitar:[1.09,.58,-24,72],eguitar:[1.15,.46,-32,66],fuzzguitar:[1.32,.63,-33,58],
 harpsichord:[.76,.64,32,57],koto:[1.08,.40,27,74],vibes:[.83,.83,0,81],
 trumpet:[1.22,.47,11,72],clarinet:[.57,1.05,-18,72],accordion:[1.07,.85,0,75],
 marimba:[.65,.77,12,59],celesta:[.51,.78,-12,77],steelpan:[.88,.73,21,69],synth:[1.07,1.04,12,78]
};
audio.onNote=(track,pitch,time,velocity,voice)=>{
 if(track.volume===0||(reduceMotion.matches&&!$('chickenEgg').open))return;
 pulseQueue.push({track,time,velocity,voice,profile:glowProfiles[track.type]});
 pulseQueue.sort((a,b)=>a.time-b.time);
 if(!pulseFrame){pulseFrame=true;requestAnimationFrame(drawPulses)}
};
function drawPulses(){
 const now=audio.ctx.currentTime,host=$('noteAtmosphere');
 while(pulseQueue.length&&pulseQueue[0].time<=now){
  const pulse=pulseQueue.shift(),{track,time,velocity,voice,profile}=pulse;
  const index=project.tracks.indexOf(track);
  if(index<0||voice.noteEnd<=time||now>voice.noteEnd+.14)continue;
  danceStage.hit(index,velocity,project.bpm);
  if(reduceMotion.matches)continue;
  if(activeGlows.size>=24){
   const oldest=activeGlows.keys().next().value;
   oldest.remove();
   activeGlows.delete(oldest);
  }
  const [width,height,angle,edge]=profile??glowProfiles.synth;
  const glow=document.createElement('i');
  glow.className='noteGlow';
  glow.style.setProperty('--pulse-color',track.color);
  glow.style.setProperty('--pulse-edge',edge+'%');
  glow.style.width=width*650+'px';
  glow.style.height=height*650+'px';
  glow.style.rotate=angle+'deg';
  glow.style.left=(8+Math.random()*84)+'%';
  glow.style.top=(12+Math.random()*76)+'%';
  host.append(glow);
  activeGlows.set(glow,pulse);
  const label=document.querySelector('[data-track-index="'+index+'"]');
  label?.animate([{backgroundColor:track.color+'45'},{backgroundColor:track.color+'00'}],{duration:400,easing:'ease-out'});
 }
 for(const [glow,{time,velocity,voice}] of activeGlows){
  const fade=Math.max(0,now-voice.noteEnd)/.14;
  if(fade>=1||reduceMotion.matches){glow.remove();activeGlows.delete(glow);continue}
  const age=now-time;
  const rise=Math.min(age/.035,1);
  glow.style.opacity=(.07+velocity*.075)*rise*(1-fade)**2;
  glow.style.scale=.77+.23*(1-Math.exp(-age*6));
 }
 if(pulseQueue.length||activeGlows.size)requestAnimationFrame(drawPulses);
 else pulseFrame=false;
}
for(let key of fxKeys)$(key).oninput=()=>{track()[key]=+$(key).value;if(key!=='pitch')audio.updateTrack(track());updateSoundLabels();save('sound-'+key+'-'+selected)};
$('pitch').ondblclick=()=>{$('pitch').value=0;$('pitch').oninput()};
function wireKnob(input){let movement=null;input.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();input.focus();input.setPointerCapture(e.pointerId);movement={x:e.clientX,y:e.clientY,value:+input.value,id:e.pointerId}});input.addEventListener('pointermove',e=>{if(!movement)return;let scale=(Number(input.max)-Number(input.min))/170;input.value=String(movement.value+(movement.y-e.clientY+(e.clientX-movement.x)*.4)*scale);input.dispatchEvent(new Event('input',{bubbles:true}))});input.addEventListener('pointerup',()=>movement=null);input.addEventListener('pointercancel',()=>movement=null);input.addEventListener('lostpointercapture',()=>movement=null)}
for(const input of document.querySelectorAll('.knob input'))wireKnob(input);
$('drumKit').innerHTML='<option value="mixed" disabled>Mixed kit</option>'+Object.entries(KITS).map(([k,v])=>'<option value="'+k+'">'+v.name+'</option>').join('');
$('drumKit').onchange=()=>{applyDrumKit(project,$('drumKit').value);for(let v of [...audio.voices])if(project.tracks.slice(0,4).includes(v.track))v.kill();renderSteps();renderSound();audio.prepareTracks(project.tracks.slice(0,4)).catch(()=>{});renderTrackHeading();save();toast('Kit applied to tracks 1–4. Individual sounds are available in Instrument.')};
$('engine').onchange=()=>{track().engine=$('engine').value;audio.prepareTrack(track()).catch(()=>{});save()};
for(const dialog of document.querySelectorAll('dialog')){
 const close=button('×',()=>dialog.close('cancel'),'dialogClose');
 close.type='button';
 close.setAttribute('aria-label','Close window');
 dialog.append(close);
}

try{let stored=localStorage.getItem('looproom-v2')||localStorage.getItem('looproom-v1');if(stored){
 const raw=JSON.parse(stored);
 project=normalize(raw);
 if(Array.isArray(raw.song)&&raw.song.length>MAX_SONG_BARS){
  localStorage.setItem('looproom-before-16-bar-limit',stored);
  toast('Restored the first 16 song bars. All patterns are available.');
 }
}}catch{toast('Could not restore the previous session. You can still open a saved project file.')}patternId=project.patterns[0].id;render();save();window.addEventListener('pagehide',()=>{stop();save()});window.addEventListener('blur',()=>{releaseScreenKeys();releaseAllMidi();if(drag){drag=null;paintNotes()}});

setTimeout(()=>{if(!audio.ctx)$('audioStatus').textContent='● Preparing sounds';audio.prime(project.master).then(()=>{if(!playing)$('audioStatus').textContent='● Ready to play'}).catch(()=>{if(!playing)$('audioStatus').textContent='● Press Play to enable audio'})},0);

if ('serviceWorker' in navigator) {
 navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('Offline setup could not start.',error));
}
