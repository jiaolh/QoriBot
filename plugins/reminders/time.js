const HOUR = 3600000, DAY = 24 * HOUR, OFFSET = 8 * HOUR;
export const TIME_ZONE = 'Asia/Shanghai';
export function formatTime(time) { return new Date(time + OFFSET).toISOString().slice(0, 19).replace('T', ' '); }
function parts(time) {
  const d = new Date(time + OFFSET);
  return { year:d.getUTCFullYear(), month:d.getUTCMonth()+1, day:d.getUTCDate(), hour:d.getUTCHours(), minute:d.getUTCMinutes(), second:d.getUTCSeconds(), weekday:d.getUTCDay() };
}
function instant(p) {
  const time = Date.UTC(p.year,p.month-1,p.day,p.hour||0,p.minute||0,p.second||0)-OFFSET, actual=parts(time);
  if (!Number.isFinite(time) || ['year','month','day','hour','minute','second'].some(key=>(p[key]||0)!==actual[key])) throw new Error('日期或时间无效，请检查年月日、小时和分钟。');
  return time;
}
function numeral(text) {
  const digits = {零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if (!/[十百千万]/.test(text)) return Number([...text].map(c=>digits[c]).join(''));
  let sum=0, section=0, n=0;
  for (const c of text) {
    if (c in digits) n=digits[c];
    else if(c==='万'){sum+=(section+n)*10000;section=0;n=0;}
    else {section+=(n||1)*({十:10,百:100,千:1000}[c]);n=0;}
  }
  return sum+section+n;
}
export function normalizeNumbers(text) { return text.replace(/[零〇一二两三四五六七八九十百千万]+/g,n=>String(numeral(n))); }
export function parseDuration(raw) {
  if(typeof raw!=='string'||raw.length>100)throw new Error('相对时间需要填写数字和单位，如 10分钟、1小时30分钟。');
  let text=normalizeNumbers(raw.trim()).replace(/后$/,'').replace(/钟头/g,'小时').replace(/(\d+)个?半小时/g,(_,n)=>`${Number(n)+0.5}小时`).replace(/半小时/g,'30分钟').replace(/半天/g,'12小时').replace(/个(?=小时|分钟|天|星期|周)/g,'');
  const units={秒:1000,秒钟:1000,分钟:60000,分:60000,小时:HOUR,时:HOUR,天:DAY,周:7*DAY,星期:7*DAY};
  let total=0, rest=text.replace(/(\d+(?:\.\d+)?)\s*(秒钟|秒|分钟|分|小时|时|天|星期|周)/g,(_,n,u)=>{total+=Number(n)*units[u];return '';}).trim();
  if(rest||!Number.isSafeInteger(total)||total<1000||total>366*DAY)throw new Error('相对时间支持秒、分钟、小时、天、周，范围为 1 秒至 366 天。');
  return total;
}
export function parseAbsolute(raw, now=Date.now()) {
  if(typeof raw!=='string'||raw.length>100)throw new Error('绝对时间需要日期和钟点，如 明天08:00 或 2026-10-07 08:00。');
  let text=normalizeNumbers(raw.trim()).replace(/北京时间/g,'').trim();
  let period='';text=text.replace(/凌晨|早上|上午|中午|下午|晚上/g,value=>{period=value;return '';});
  text=text.replace(/(\d{1,2})[点时](半|\d{1,2}分?)?/g,(_,h,m)=>`${h}:${m==='半'?'30':(m||'00').replace('分','')}`).replace(/：/g,':');
  const full=text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*[T ]?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  const clock=text.match(/^(今天|明天|后天)?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if(!full&&!clock)throw new Error('无法识别绝对时间，请用 明天08:00 或 2026-10-07 08:00（北京时间）。');
  const date=full?{year:+full[1],month:+full[2],day:+full[3]}:parts(now+({今天:0,明天:1,后天:2}[clock[1]]||0)*DAY);
  let hour=+(full?full[4]:clock[2]),minute=+(full?full[5]:clock[3]),second=+(full?full[6]||0:clock[4]||0);
  if(['下午','晚上'].includes(period)&&hour<12)hour+=12;
  if(period==='中午'&&hour<11)hour+=12;
  if(period==='凌晨'&&hour===12)hour=0;
  if(hour>23||minute>59||second>59)throw new Error('钟点无效，小时应为 0–23，分钟和秒应为 0–59。');
  let time=instant({...date,hour,minute,second});
  if(!full&&!clock[1]&&time<=now)time+=DAY;
  if(time<=now)throw new Error('预约时间已经过去，请填写将来的时间。');
  if(time>now+5*366*DAY)throw new Error('预约时间不能超过未来五年。');
  return time;
}
export function compileSchedule(input, now=Date.now()) {
  if(!input||!['absolute','relative'].includes(input.timeType))throw new Error('请选择绝对时间或相对时间。');
  let firstAt=input.timeType==='relative'?now+parseDuration(input.when):parseAbsolute(input.when,now);
  const repeat=input.repeat||'once';
  if(!['once','daily','weekly','workdays','monthly','interval'].includes(repeat))throw new Error('重复规则无效。');
  if(repeat==='workdays')while([0,6].includes(parts(firstAt).weekday))firstAt+=DAY;
  const p=parts(firstAt), schedule={version:1,timeZone:TIME_ZONE,timeType:input.timeType,when:input.when,repeat,firstAt,hour:p.hour,minute:p.minute,second:p.second,weekday:p.weekday,day:p.day};
  if(repeat==='interval'){schedule.intervalMs=parseDuration(input.interval||input.when);if(schedule.intervalMs<60000)throw new Error('重复间隔至少为 1 分钟。');}
  if(input.endAt){schedule.endAt=parseAbsolute(input.endAt,now);if(schedule.endAt<firstAt)throw new Error('结束时间不能早于首次提醒。');}
  return schedule;
}
export function nextOccurrence(schedule, after) {
  let candidate;
  if(after<schedule.firstAt)candidate=schedule.firstAt;
  else if(schedule.repeat==='once')return null;
  else if(schedule.repeat==='interval')candidate=schedule.firstAt+(Math.floor((after-schedule.firstAt)/schedule.intervalMs)+1)*schedule.intervalMs;
  else {
    const base=parts(after), midnight=Date.UTC(base.year,base.month-1,base.day)-OFFSET;
    for(let i=0;i<370;i++){
      const p=parts(midnight+i*DAY);
      if(schedule.repeat==='weekly'&&p.weekday!==schedule.weekday)continue;
      if(schedule.repeat==='workdays'&&[0,6].includes(p.weekday))continue;
      if(schedule.repeat==='monthly'&&p.day!==schedule.day)continue;
      const time=instant({...p,hour:schedule.hour,minute:schedule.minute,second:schedule.second});
      if(time>after&&time>=schedule.firstAt){candidate=time;break;}
    }
  }
  return candidate&&(!schedule.endAt||candidate<=schedule.endAt)?candidate:null;
}
export function describeSchedule(schedule) {
  const repeat={once:'仅一次',daily:'每天',weekly:'每周',workdays:'工作日',monthly:'每月',interval:`每隔 ${schedule.intervalMs/60000} 分钟`}[schedule.repeat];
  return `${schedule.timeType==='relative'?'相对时间':'绝对时间'} · ${repeat} · 北京时间${schedule.endAt?' · 截止 '+formatTime(schedule.endAt):''}`;
}
