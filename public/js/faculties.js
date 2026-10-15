const facultyPrograms={
Computing:["B.Sc. Computer Science","B.Sc. Information Technology","B.Sc. Cyber Security","B.Sc. Software Engineering","B.Sc. Data Management"],
Agricultural:["B.Agric Animal Science","B.Agric Crop Science","B.Agric Agric Economics"],
Arts:["B.A. English","B.A. French","B.A. Philosophy"],
Education:["B.A.(Ed) English","B.Sc.(Ed) Computer Science","B.Sc.(Ed) Biology"],
Health:["B.NSc. Nursing","B.Sc. Public Health"],
Law:["LL.B Law"],
Management:["B.Sc. Accounting","B.Sc. Business Admin","B.Sc. Public Admin"],
Sciences:["B.Sc. Biology","B.Sc. Chemistry","B.Sc. Physics","B.Sc. Maths"],
Social:["B.Sc. Economics","B.Sc. Mass Communication","B.Sc. Political Science","B.Sc. Criminology"]
};
document.addEventListener('DOMContentLoaded',()=>{
const f=document.getElementById('faculty');
const d=document.getElementById('department');
if(!f||!d) return;
f.addEventListener('change',()=>{
const list=facultyPrograms[f.value]||[];
d.innerHTML=list.length?'<option value="">-- Select Programme --</option>'+list.map(p=>`<option value="${p}">${p}</option>`).join(''):'<option value="">-- Select Faculty First --</option>';
});
});