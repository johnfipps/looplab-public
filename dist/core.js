import {hippoHoppo} from './demo-song.js';

export const STEPS=16;
export const MAX_SONG_BARS=16;
export const clamp=(v,a,b,d=a)=>Number.isFinite(+v)?Math.min(b,Math.max(a,+v)):d;
export const stepOffset=(step,bpm,swing)=>step*60/bpm/4+(step%2?60/bpm/4*swing*.75:0);
export const noteOffset=(position,bpm,swing)=>{let p=clamp(position,0,16),s=Math.floor(p);return s===16?stepOffset(16,bpm,swing):stepOffset(s,bpm,swing)+(p-s)*(stepOffset(s+1,bpm,swing)-stepOffset(s,bpm,swing))};
export function gridPosition(elapsed,bpm,swing){if(elapsed<=0)return 0;for(let s=0;s<16;s++){let a=stepOffset(s,bpm,swing),b=stepOffset(s+1,bpm,swing);if(elapsed<=b)return s+(elapsed-a)/(b-a)}return 16}
export const validColor=(value,fallback)=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)?value:fallback;
export const nearestStep=(elapsed,bpm,swing)=>{let best=0,d=Infinity;for(let s=0;s<16;s++){let gap=Math.abs(elapsed-stepOffset(s,bpm,swing));if(gap<d){best=s;d=gap}}return best};
// Use the controller event time on the same clock as the audible transport.
export function midiEventTime(context,timestamp,receivedAt){
  if(!Number.isFinite(timestamp)||timestamp<=0||timestamp>receivedAt)return context.currentTime;
  const output=context.getOutputTimestamp?.();
  if(output?.performanceTime>0)return output.contextTime+(timestamp-output.performanceTime)/1000;
  return context.currentTime-(receivedAt-timestamp)/1000;
}

export function midiRecordPosition(bars,time,quantized){
  for(let i=bars.length-1;i>=0;i--){
    const bar=bars[i],previous=bars[i-1];
    const firstStep=bar.firstStep??0;
    const start=bar.time+stepOffset(firstStep,bar.tempo,bar.swing);
    const beatGap=previous?stepOffset(16,previous.tempo,previous.swing)-stepOffset(15,previous.tempo,previous.swing):60/bar.tempo/4;
    // Count-in gets a small pickup window. Between bars, quantize can choose either downbeat neighbor.
    const early=previous?(quantized?beatGap/2:Math.min(.030,beatGap/3)):bar.early??.035;
    if(time<start-early)continue;
    const elapsed=time-bar.time;
    const step=quantized?nearestStep(elapsed,bar.tempo,bar.swing):Math.min(16-.0001,gridPosition(elapsed,bar.tempo,bar.swing));
    return {bar,step:Math.max(firstStep,step)};
  }
  return null;
}

export function midiNoteLength(bar,step,elapsed){
  const remaining=16-step;
  const start=noteOffset(step,bar.tempo,bar.swing);
  return clamp(gridPosition(start+Math.max(0,elapsed),bar.tempo,bar.swing)-step,Math.min(.05,remaining),remaining);
}

const recordedMidiHits=new WeakMap();
export function writeMidiHit(part,{bar,step,pitch,time,velocity,pad,quantized}){
  let parts=recordedMidiHits.get(bar);
  if(!parts)recordedMidiHits.set(bar,parts=new WeakMap());
  let hits=parts.get(part);
  if(!hits)parts.set(part,hits=new Map());
  const key=(pad&&quantized?'pad:':'note:')+pitch+':'+step;
  const previous=hits.get(key);
  let position=step;
  if(previous){
    // Keep the first hit on the grid, then retain fast repeats inside its step.
    const span=Math.floor(step)+1-step;
    const gap=noteOffset(step+span,bar.tempo,bar.swing)-noteOffset(step,bar.tempo,bar.swing);
    const fraction=Math.min(1,(time-previous.time)/gap);
    position=Math.min(step+span*(.9999-.001/(previous.count+1)),
      Math.max(previous.position+span*.0001,step+span*fraction));
    previous.position=position;
    previous.count++;
  }else hits.set(key,{time,position,count:1});

  if(pad&&quantized&&!previous){
    part.steps[step]=true;
    part.velocities[step]=velocity;
    return null;
  }
  const note={pitch,step:position,length:Math.min(pad ? .25 : .05,16-position),velocity};
  const existing=part.notes.findIndex(old=>old.pitch===pitch&&old.step===position);
  if(existing>=0&&!previous)part.notes[existing]=note;
  else if(part.notes.length<2048)part.notes.push(note);
  else return null;
  return note;
}
export const emptyPart=()=>({steps:Array(16).fill(false),velocities:Array(16).fill(.8),notes:[]});
export function spectrumColor(index){let hue=((Math.floor(index)%12)+12)%12/12,s=.72,l=.68;let a=s*Math.min(l,1-l);let channel=n=>{let k=(n+hue*12)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0')};return '#'+channel(0)+channel(8)+channel(4)}
export function takePatternColor(project){let color=spectrumColor(project.nextPatternColor);project.nextPatternColor++;return color}
export const emptyPattern=(id,name,color=spectrumColor(0))=>({id,name,color,parts:Array.from({length:8},emptyPart)});
export const copy=o=>JSON.parse(JSON.stringify(o));
export function moveNote(note,step,pitch){return {...note,step:clamp(Math.round(step),0,16-note.length),pitch:clamp(Math.round(pitch),36,84)}}
export function resizeNote(note,length){
  const resized={...note,length:clamp(Math.round(length),1,16-note.step)};
  if(note.expression)resized.expression=note.expression.filter(point=>point.offset<=resized.length);
  return resized;
}

export function recordNoteExpression(note,offset,{bend,mod}){
  const points=note.expression??=[];
  const last=points.at(-1);
  if(last?.bend===bend&&last?.mod===mod)return;
  const point={offset,bend,mod};
  // Coalesce dense controller messages while preserving the note-on state.
  if(points.length>=256||(points.length>1&&offset-last.offset<.06))points[points.length-1]=point;
  else points.push(point);
}

function normalizeNote(note){
  const clean={pitch:note.pitch,step:note.step,length:note.length,velocity:clamp(note.velocity,0,1,.8)};
  if(Array.isArray(note.expression)){
    const points=note.expression.slice(0,256)
      .filter(point=>point&&Number.isFinite(point.offset)&&point.offset>=0&&point.offset<=note.length)
      .map(point=>({offset:point.offset,bend:clamp(point.bend,-1,1,0),mod:clamp(point.mod,0,1,0)}))
      .sort((a,b)=>a.offset-b.offset);
    if(points.length)clean.expression=points;
  }
  return clean;
}
export const INSTRUMENTS={kick:'Bass drum',snare:'Snare',open:'Open hi-hat',crash:'Crash cymbal',closed:'Closed hi-hat',clap:'Clap',tom:'Tom',piano:'Acoustic piano',epiano:'Rhodes-style electric piano',organ:'Drawbar organ',aguitar:'Acoustic guitar',eguitar:'Electric guitar',fuzzguitar:'Fuzz Guitar',bass:'Plucked bass',pbass:'P-Bass',harpsichord:'Harpsichord',koto:'Koto',strings:'Strings',flute:'Flute',vibes:'Vibraphone',trumpet:'Trumpet',clarinet:'Clarinet',accordion:'Accordion',marimba:'Marimba',celesta:'Celesta',steelpan:'Steel pan',synth:'Synthesizer'};
export const INSTRUMENT_GROUPS={'Keys':['piano','epiano','organ','harpsichord','celesta'],'Strings & plucks':['aguitar','eguitar','fuzzguitar','bass','pbass','koto','strings'],'Winds & brass':['flute','clarinet','trumpet','accordion'],'Mallets & tuned percussion':['vibes','marimba','steelpan'],'Synthesis':['synth']};
export const INSTRUMENT_TIPS={piano:'Try C–E–G together: your first major chord.',epiano:'Play softly, then harder—hear the bell-like bite change.',organ:'Hold a chord and change one note at a time.',aguitar:'Play chord notes one after another to make an arpeggio.',eguitar:'Try a short melody and leave room between phrases.',bass:'Start with the root note on beats 1 and 3.',harpsichord:'Try a repeating pattern with one note changing each time.',koto:'Explore C, D, E, G, and A: a five-note scale.',strings:'Build a chord from a low note, a middle note, and a high note.',flute:'Sing a little phrase, then find its notes.',vibes:'Try a gentle melody with a little reverb.',trumpet:'Try a short call and answer with two or three notes.',clarinet:'Try holding a low note, then play it an octave higher.',accordion:'Hold two or three notes together for a rich chord.',marimba:'Try alternating two notes to make a rhythmic pattern.',celesta:'Try a high melody over a quiet bass line.',steelpan:'Try a syncopated melody between the beats.',synth:'Try the same phrase on different engines and compare their colors.'};
export const defaultDrumMidi=()=>({enabled:true,channel:10,preset:'minilab',notes:[36,37,38,39,40,41,42,43]});
export function drumMidiPreset(name){return name==='gm'?{enabled:true,channel:10,preset:'gm',notes:[36,38,42,46]}:defaultDrumMidi()}
export function normalizeDrumMidi(raw) {
  const defaults = defaultDrumMidi();
  if (!raw) return defaults;

  const preset = ['minilab', 'gm', 'custom'].includes(raw.preset) ? raw.preset : 'custom';
  let notes = raw.notes;
  if (preset === 'minilab' && Array.isArray(notes) && notes.length === 4) {
    notes = [...notes, ...defaults.notes.slice(4)];
  }
  const valid = Array.isArray(notes) && [4, 8].includes(notes.length)
    && notes.every(note => Number.isInteger(note) && note >= 0 && note <= 127)
    && new Set(notes).size === notes.length;
  return {
    enabled: raw.enabled !== false,
    channel: Math.round(clamp(raw.channel ?? 10, 0, 16, 10)),
    preset,
    notes: valid ? notes.slice() : drumMidiPreset(preset).notes,
  };
}

const miniLabKnobCCs = [[74,71,76,77,93,18,19,16], [86,87,89,90,110,111,116,117]];
export function miniLabMixerTarget(cc) {
  if (cc === 17 || cc === 31) return 'master';
  for (const program of miniLabKnobCCs) {
    const knob = program.indexOf(cc);
    if (knob >= 0) return knob;
  }
  return null;
}

export function isMiniLabInput(name = '') {
  return /mini\s*lab\s*3(?!\d)/i.test(name)
    && !/\b(?:din|thru|mcu|hui|alv)\b|midi\s*(?:in\s*)?[2-4]\b/i.test(name);
}

export const isBassInstrument=type=>type==='bass'||type==='pbass';
export const trackTriggerPitch=type=>isBassInstrument(type)?48:60;

export function routeMidiNote(mapping, channel, note, selected, tracks) {
  if (mapping.enabled && (mapping.channel === 0 || channel === mapping.channel)) {
    const index = mapping.notes.indexOf(note);
    if (index >= 0 && tracks[index]) {
      return {track: index, pitch: trackTriggerPitch(tracks[index].type), pad: true};
    }
    if (mapping.channel !== 0) return null;
  }
  return {track: selected, pitch: note, pad: false};
}

export function learnDrumNote(mapping,index,note,channel){let previous=mapping.notes[index],other=mapping.notes.indexOf(note);if(other>=0&&other!==index)mapping.notes[other]=previous;mapping.notes[index]=note;mapping.channel=channel;mapping.preset='custom';mapping.enabled=true;return mapping}

export const KITS={tr808:{name:'808 · Analog',tone:.92,grit:.08},rock:{name:'Rock · Live room',tone:1.15,grit:.12},hiphop:{name:'Hip-hop · Heavy',tone:.8,grit:.35},breakbeat:{name:'Breakbeat',tone:1.3,grit:.24},lofi:{name:'Lo-fi · Dusty',tone:.82,grit:.5}};
const kitTrackTypes=['kick','snare','closed','crash'];
export const DRUM_TYPES=[...kitTrackTypes,'open','clap','tom'];
export const ENGINES={analog:'Analog duo',fm:'FM bell / keys',pluck:'Plucked string',wavetable:'Soft harmonic'};
export function isTrackAudible(track,tracks){return !track.mute&&(!tracks.some(t=>t.solo)||!!track.solo)}
export const voiceLimitSeconds=bpm=>240/clamp(bpm,40,240,112);
export function applyDrumKit(project,kit){if(!KITS[kit])throw Error('Unknown kit');kitTrackTypes.forEach((type,i)=>{let t=project.tracks[i];t.type=type;t.kit=kit;if(!t.customName)t.name=INSTRUMENTS[type]})}
export function currentKit(project){let first=project.tracks.slice(0,4);return first.every((t,i)=>t.type===kitTrackTypes[i]&&t.kit===first[0].kit)?first[0].kit:'mixed'}
export const PRESETS={warm:{name:'Warm analog',wave:'sawtooth',tone:1800,attack:.015,release:.3},sub:{name:'Round sub bass',wave:'sine',tone:600,attack:.005,release:.12},bright:{name:'Bright lead',wave:'sawtooth',tone:5200,attack:.008,release:.2},soft:{name:'Soft triangle',wave:'triangle',tone:2800,attack:.02,release:.4},hollow:{name:'Hollow square',wave:'square',tone:1600,attack:.01,release:.25},pad:{name:'Slow motion pad',wave:'sawtooth',tone:1600,attack:.3,release:1.1}};
// Each instrument pairs its articulation with frequency ratios and relative levels.
export const MODELED_INSTRUMENTS={
 trumpet:{envelope:{attack:.024,decay:.16,sustain:.72,release:.11},partials:[[1,.48],[2,.22],[3,.18],[4,.10],[5,.06],[7,.03]]},
 clarinet:{envelope:{attack:.032,decay:.18,sustain:.78,release:.13},partials:[[1,.66],[3,.24],[5,.10],[7,.045],[9,.015]]},
 accordion:{envelope:{attack:.018,decay:.15,sustain:.83,release:.095},partials:[[1,.33,-7],[1,.33,7],[2,.14],[3,.13],[4,.055],[5,.04]]},
 marimba:{envelope:{attack:.002,decay:.52,sustain:0,release:.11},partials:[[1,.76],[4,.15],[9.8,.07]]},
 celesta:{envelope:{attack:.002,decay:1.8,sustain:0,release:.28},partials:[[1,.66],[2,.12],[2.76,.15],[5.42,.08]]},
 steelpan:{envelope:{attack:.003,decay:.9,sustain:0,release:.19},partials:[[1,.53],[2.01,.24],[3.01,.15],[4.87,.07],[6.13,.045]]}
};
export const ENVELOPES={kick:{attack:.003,decay:.22,sustain:0,release:.07},snare:{attack:.002,decay:.13,sustain:0,release:.05},open:{attack:.002,decay:.28,sustain:0,release:.06},crash:{attack:.002,decay:.65,sustain:0,release:.08},closed:{attack:.001,decay:.045,sustain:0,release:.02},clap:{attack:.003,decay:.14,sustain:0,release:.04},tom:{attack:.003,decay:.24,sustain:0,release:.07},bass:{attack:.008,decay:.32,sustain:.35,release:.14},pbass:{attack:.004,decay:.56,sustain:.18,release:.09},piano:{attack:.006,decay:1.1,sustain:.08,release:.3},epiano:{attack:.008,decay:.8,sustain:.18,release:.45},organ:{attack:.01,decay:.22,sustain:.72,release:.09},strings:{attack:.16,decay:.55,sustain:.6,release:.65},pluck:{attack:.004,decay:.26,sustain:.03,release:.16},aguitar:{attack:.004,decay:.6,sustain:.08,release:.16},eguitar:{attack:.004,decay:.55,sustain:.13,release:.18},fuzzguitar:{attack:.003,decay:.84,sustain:.22,release:.15},harpsichord:{attack:.002,decay:.38,sustain:.04,release:.1},koto:{attack:.003,decay:.65,sustain:.05,release:.18},flute:{attack:.055,decay:.22,sustain:.65,release:.16},vibes:{attack:.003,decay:1.2,sustain:.08,release:.3},synth:{attack:.015,decay:.3,sustain:.6,release:.3}};
Object.values(PRESETS).forEach(p=>{p.decay=p.name==='Slow motion pad'?.7:.3;p.sustain=p.name==='Round sub bass'?.4:.6});
export function envelopeLevel(elapsed,envelope,peak=1){if(elapsed<=0)return 0;if(elapsed<envelope.attack)return peak*elapsed/envelope.attack;let progress=Math.min(1,(elapsed-envelope.attack)/envelope.decay);return peak*(1+(envelope.sustain-1)*progress)}
const defaultTrackColors=['#df599e','#eb793d','#ac77df','#51bad3','#5983eb','#48ba9d','#d65a68','#bf8e54'];
export const makeTrack=(name,type,i)=>({name,type,pitch:0,volume:.75,mute:false,solo:false,kit:'tr808',engine:'analog',color:defaultTrackColors[i],preset:'warm',wave:'sawtooth',tone:1800,...(MODELED_INSTRUMENTS[type]?.envelope||ENVELOPES[type]),compressor:0,filter:0,overdrive:0,reverb:0,delay:0,delayTime:.28});
export function freshProject(){let tracks=[...kitTrackTypes,'bass','piano','organ','strings'].map((type,i)=>makeTrack(INSTRUMENTS[type],type,i));return {version:2,title:'Untitled groove',bpm:112,swing:0,master:.7,metronome:false,metronomeVolume:.5,midiQuantize:true,fullLevel:false,countIn:false,mode:'pattern',drumMidi:defaultDrumMidi(),tracks,nextPatternColor:1,patterns:[emptyPattern('p1','Pattern 1')],song:['p1']}}
export function normalize(raw){if(!raw||!Array.isArray(raw.tracks)||raw.tracks.length!==8)throw Error('Choose a looplab! project file.');let p=freshProject();p.title=String(raw.title||p.title).slice(0,80);p.bpm=clamp(raw.bpm,40,240,112);p.master=clamp(raw.master,0,1,.7);p.swing=clamp(raw.swing,0,1);p.metronome=!!raw.metronome;p.metronomeVolume=clamp(raw.metronomeVolume??.5,0,1,.5);p.midiQuantize=raw.midiQuantize!==false;p.fullLevel=raw.fullLevel===true;p.countIn=!!raw.countIn;p.mode=raw.mode==='song'?'song':'pattern';p.drumMidi=normalizeDrumMidi(raw.drumMidi);p.tracks=raw.tracks.map((t,i)=>{if(t.type==='pluck')t={...t,type:'aguitar',name:t.customName?t.name:INSTRUMENTS.aguitar};if(!INSTRUMENTS[t.type])throw Error('Unknown instrument in project.');if(!t.customName&&['Piano','Electric piano','Organ','Bass guitar'].includes(t.name))t={...t,name:INSTRUMENTS[t.type]};let d=makeTrack(String(t.name||INSTRUMENTS[t.type]).slice(0,32),t.type,i);return {...d,color:validColor(t.color,d.color),solo:!!t.solo,kit:t.kit==='amen'?'breakbeat':KITS[t.kit]?t.kit:'tr808',engine:ENGINES[t.engine]?t.engine:'analog',customName:!!t.customName,pitch:Math.round(clamp(t.pitch,-12,12,0)),volume:clamp(t.volume,0,1,.75),mute:!!t.mute,preset:PRESETS[t.preset]||t.preset==='custom'?t.preset:'warm',wave:['sine','triangle','square','sawtooth'].includes(t.wave)?t.wave:d.wave,tone:clamp(t.tone,150,10000,1800),attack:clamp(t.attack??d.attack,.001,2,d.attack),decay:clamp(t.decay??d.decay,.01,3,d.decay),sustain:clamp(t.sustain??d.sustain,0,1,d.sustain),release:clamp(t.release??d.release,.01,3,d.release),compressor:clamp(t.compressor??0,0,1),overdrive:clamp(t.overdrive??0,0,1),filter:clamp(t.filter??0,0,1),reverb:clamp(t.reverb??0,0,1),delay:clamp(t.delay??0,0,1),delayTime:clamp(t.delayTime??.28,.06,.8,.28)}});
let patterns=raw.version===1?[{id:'p1',name:'Pattern 1',parts:raw.tracks}]:raw.patterns;
if(!Array.isArray(patterns)||!patterns.length||patterns.length>64)throw Error('Project must contain 1–64 patterns.');let ids=new Set();p.patterns=patterns.map((pat,i)=>{let id=String(pat.id||'p'+(i+1));if(ids.has(id))throw Error('Duplicate pattern ID.');ids.add(id);if(!Array.isArray(pat.parts)||pat.parts.length!==8)throw Error('Invalid pattern tracks.');return {id,name:String(pat.name||'Pattern '+(i+1)).slice(0,32),color:validColor(pat.color,spectrumColor(i)),parts:pat.parts.map(part=>{if(!Array.isArray(part.steps)||part.steps.length!==16||!Array.isArray(part.notes)||part.notes.length>2048)throw Error('Invalid notes or steps.');return {steps:part.steps.map(Boolean),velocities:Array.from({length:16},(_,i)=>clamp(part.velocities?.[i]??.8,0,1,.8)),notes:part.notes.filter(n=>Number.isInteger(n.pitch)&&n.pitch>=36&&n.pitch<=84&&Number.isFinite(n.step)&&n.step>=0&&n.step<16&&Number.isFinite(n.length)&&n.length>0&&n.length<=16-n.step).map(normalizeNote)}})}});p.nextPatternColor=Math.max(p.patterns.length,Math.floor(clamp(raw.nextPatternColor??p.patterns.length,1,1000000,p.patterns.length)));p.song=Array.isArray(raw.song)?raw.song.filter(id=>ids.has(id)).slice(0,MAX_SONG_BARS):[p.patterns[0].id];if(!p.song.length)p.song=[p.patterns[0].id];return p}

export const DEMO_TITLE=hippoHoppo.title;

export function demoProject(){
  const project=normalize(hippoHoppo);
  const [kick,snare,closedHat,openHat,clap,koto,organ,strings]=project.tracks;
  Object.assign(kick,{volume:.70,color:'#a9cf7e'});
  Object.assign(snare,{reverb:.29});
  Object.assign(closedHat,{volume:.37});
  Object.assign(openHat,{volume:.52});
  Object.assign(clap,{volume:.12,delay:.42,reverb:.58});
  Object.assign(koto,{volume:.70,delay:.48,delayTime:30/project.bpm,reverb:.48});
  Object.assign(organ,{volume:.27,reverb:.56});
  Object.assign(strings,{delay:.46,reverb:.62});

  const labels={
    groove:'A · Main groove',
    'groove-plus':'A+ · Kick switch',
    'organ-reply':'B · Organ reply',
    'organ-lift':'C · Organ lift',
    'kick-roll':'C · Kick roll'
  };
  for(const pattern of project.patterns){
    pattern.name=labels[pattern.id];
    for(const [step,on] of pattern.parts[2].steps.entries()){
      if(on)pattern.parts[2].velocities[step]=step%4===0?.78:step%2===0?.52:.40;
    }
    if(pattern.parts[1].steps[14])pattern.parts[1].velocities[14]=.54;
  }

  const intro=copy(project.patterns[0]);
  Object.assign(intro,{id:'koto-intro',name:'Koto intro',color:'#ad9fe1'});
  intro.parts.slice(0,5).forEach((part,index)=>{
    const hits=[[0],[],[8,12],[14],[]][index];
    part.steps=part.steps.map((on,step)=>hits.includes(step));
  });

  const roll=project.patterns.find(pattern=>pattern.id==='kick-roll');
  const rollVelocity=roll.parts[0].velocities;
  [12,13,14,15].forEach((step,index)=>{rollVelocity[step]=[.62,.70,.82,.94][index]});

  const outro=copy(roll);
  Object.assign(outro,{id:'turnaround',name:'C · Turnaround',color:'#80b8ce'});
  outro.parts[6].notes.push({
    pitch:74,step:15,length:.9,velocity:.72,
    expression:[{offset:0,bend:-.35,mod:0},{offset:.28,bend:0,mod:.12},{offset:.55,bend:0,mod:.40}]
  });
  project.patterns.unshift(intro);
  project.patterns.push(outro);
  project.song[0]=intro.id;
  project.song[project.song.length-1]=outro.id;
  project.nextPatternColor=project.patterns.length;
  return project;
}
