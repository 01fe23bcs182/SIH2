// app.js (frontend)
// Connect socket.io, implement auth, teacher/student flows, quizzes, leaderboard, admin

let socket = null;

// --- Auth helpers ---
function getUser(){ try{ return JSON.parse(sessionStorage.getItem('user')); }catch(e){return null} }
function setUser(u){ sessionStorage.setItem('user', JSON.stringify(u)); }
function clearUser(){ sessionStorage.removeItem('user'); }

// make sure a user is present (redirect to login if absent)
function initAuth(){
  const u = getUser();
  const navUser = document.getElementById('navUser');
  if(navUser) navUser.innerText = u ? `${u.name} (${u.role})` : 'Not logged in';
  // connect socket if logged in
  if(u && !socket){
    socket = io();
    socket.on('connect', ()=> console.log('socket connected', socket.id));
    socket.emit('join', { role: u.role, class: u.class || null, username: u.username, userId: u.id });
    socket.on('drillStarted', (drill) => {
      console.log('drillStarted', drill);
      // update UI: students should show alert box
      if(u.role === 'student') showDrillAlert(drill);
      if(u.role === 'teacher') refreshLiveReport(); // teacher's own tab
      // admin can later update UI via initAdmin fetch
    });
    socket.on('studentResponded', (info)=> {
      console.log('studentResponded', info);
      if(u.role === 'teacher') refreshLiveReport();
    });
  }
}

// --- Teacher functions ---
function initTeacher(){
  const u = getUser();
  if(!u || u.role !== 'teacher'){ location.href = 'login.html?role=teacher'; return; }
  document.getElementById('greetTeacher').innerText = `Welcome, ${u.name}`;

  // add-student
  const addForm = document.getElementById('addStudentForm');
  addForm && addForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(addForm);
    const username = fd.get('username').trim();
    const name = fd.get('name').trim();
    const cls = fd.get('class').trim() || 'ClassA';
    const password = fd.get('password').trim(); // teacher should use DOB format
    const res = await fetch('/add-student', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username, password, name, class: cls })
    });
    const data = await res.json();
    const rdiv = document.getElementById('addResult');
    if(!data.success) rdiv.innerText = 'Error: '+data.message;
    else rdiv.innerText = `Student added (USN: ${username}). Password = DOB given.`;
    addForm.reset();
  });

  // start drill
  const startForm = document.getElementById('startDrillForm');
  startForm && startForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(startForm);
    const type = fd.get('type');
    const cls = fd.get('class') || 'ClassA';
    const message = fd.get('message') || `${type} started. Follow instructions.`;
    const res = await fetch('/start-drill', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type, class: cls, message, startedBy: u.name })
    });
    const data = await res.json();
    if(data.success){
      alert('Drill started');
      startForm.reset();
      // show immediate report
      setTimeout(()=> refreshLiveReport(), 200);
    } else alert('Could not start drill');
  });

  // initial live report load
  refreshLiveReport();
}

async function refreshLiveReport(){
  // get latest drill for the teacher's class (the teacher page doesn't store class; we will show latest overall)
  // simpler approach: call /reports and show the most recent drill
  const res = await fetch('/reports');
  const data = await res.json();
  const live = document.getElementById('liveReport');
  if(!data.success || data.reports.length === 0){ live.innerText = 'No drills found'; return; }
  const recent = data.reports[0]; // latest
  live.innerHTML = `<div><strong>${recent.type}</strong> • Class: ${recent.class} • ${new Date(recent.startedAt).toLocaleString()} • Responses: ${recent.responsesCount}</div>`;
}

// --- Student functions ---
function initStudent(){
  const u = getUser();
  if(!u || u.role !== 'student'){ location.href = 'login.html?role=student'; return; }
  document.getElementById('greetStudent').innerText = `Hello, ${u.name}`;
  initAuth(); // ensures socket

  // fetch any current drill for class
  fetch(`/current-drill/${u.class || 'ClassA'}`).then(r=>r.json()).then(data=>{
    if(data.success && data.drill) showDrillAlert(data.drill);
  });

  // refresh leaderboard
  refreshLeaderboard();
}

function showDrillAlert(drill){
  const box = document.getElementById('alertBox');
  if(!box) return;
  // only show if for this class or 'ALL'
  const u = getUser();
  if(drill.class && u && drill.class !== u.class && drill.class !== 'ALL') {
    box.innerHTML = '<div class="small">No active drills for your class.</div>';
    return;
  }
  box.innerHTML = `<h4>${drill.type}</h4><p>${drill.message}</p><div style="margin-top:8px"><button id="btnSafe" class="btn btn-primary">I\'m Safe</button></div>`;
  document.getElementById('btnSafe').onclick = async ()=>{
    const res = await fetch('/mark-safe', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ drillId: drill.id, studentId: getUser().id })
    });
    const d = await res.json();
    if(d.success){ alert('Marked safe'); }
    else alert('Error');
  };
}

// --- Admin functions ---
async function initAdmin(){
  const u = getUser();
  if(!u || u.role !== 'admin'){ location.href = 'login.html?role=teacher'; return; }
  document.getElementById('greetAdmin').innerText = `Admin: ${u.name}`;
  const res = await fetch('/reports');
  const data = await res.json();
  const node = document.getElementById('adminReports');
  if(!data.success){ node.innerText = 'Error loading reports'; return; }
  if(data.reports.length === 0){ node.innerText = 'No reports yet'; return; }
  let html = '<table class="table"><thead><tr><th>Type</th><th>Class</th><th>Date</th><th>Responses</th></tr></thead><tbody>';
  data.reports.forEach(r => {
    html += `<tr><td>${r.type}</td><td>${r.class}</td><td>${new Date(r.startedAt).toLocaleString()}</td><td>${r.responsesCount}</td></tr>`;
  });
  html += '</tbody></table>';
  node.innerHTML = html;
}

// --- Quizzes + Leaderboard (simple local leaderboard stored in server? we'll keep in sessionStorage) ---
function startQuiz(topic){
  if(typeof quizzes === 'undefined'){ alert('Quizzes file missing'); return; }
  currentQuiz = quizzes[topic] || [];
  if(currentQuiz.length === 0){ alert('No questions'); return; }
  currentIndex = 0; currentScore = 0;
  document.getElementById('quizModal').style.display = 'flex';
  document.getElementById('quizTitle').innerText = topic.toUpperCase() + ' Quiz';
  loadQuestion();
}
let currentQuiz = [], currentIndex = 0, currentScore = 0;
function loadQuestion(){
  const q = currentQuiz[currentIndex];
  document.getElementById('quizQuestion').innerText = q.q;
  let html = '';
  q.options.forEach((opt,i) => html += `<label style="display:block;margin:6px 0"><input type="radio" name="opt" value="${i}"> ${opt}</label>`);
  document.getElementById('quizOptions').innerHTML = html;
}
function nextQuestion(){
  const choice = document.querySelector('input[name="opt"]:checked');
  if(!choice){ alert('Pick an answer'); return; }
  if(parseInt(choice.value,10) === currentQuiz[currentIndex].answer) currentScore++;
  currentIndex++;
  if(currentIndex < currentQuiz.length) loadQuestion();
  else {
    alert('Score: ' + currentScore + '/' + currentQuiz.length);
    // store leaderboard in localStorage keyed by username
    const u = getUser();
    if(u){
      const scores = JSON.parse(localStorage.getItem('studentScores') || '{}');
      scores[u.username] = (scores[u.username] || 0) + currentScore;
      localStorage.setItem('studentScores', JSON.stringify(scores));
      refreshLeaderboard();
    }
    closeQuiz();
  }
}
function closeQuiz(){ document.getElementById('quizModal').style.display = 'none'; }
function refreshLeaderboard(){
  const node = document.getElementById('leaderboard');
  if(!node) return;
  const scores = JSON.parse(localStorage.getItem('studentScores') || '{}');
  const arr = Object.entries(scores).sort((a,b)=>b[1]-a[1]);
  if(arr.length === 0){ node.innerText = 'No scores yet'; return; }
  let html = '<table class="table"><thead><tr><th>Student</th><th>Points</th></tr></thead><tbody>';
  arr.forEach(([name,pts]) => html += `<tr><td>${name}</td><td>${pts}</td></tr>`);
  html += '</tbody></table>';
  node.innerHTML = html;
}
