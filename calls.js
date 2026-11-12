"use strict";
// Seuss Calls: Supabase Auth + private Realtime signaling; peer-to-peer WebRTC media.
// No recordings, no media uploads, no open call directory.
(() => {
  const PROJECT_URL="https://cihzaevtdoquseoxxdqf.supabase.co";
  const PUBLISHABLE_KEY="sb_publishable_TKOD-qL58VJU9c4R952W_w_Tw7qbqgL";
  const $=id=>document.getElementById(id);
  if(!$("callsOverlay"))return;
  let client=null,user=null,profile=null,booting=null;
  let channel=null,roomId=null,invite="",localMic=null,localCamera=null,connected=false,closed=false;
  const peers=new Map(), candidateQueues=new Map(), remoteStreams=new Map();
  let busy=false;

  function status(text,error=false){
    $("callsStatus").textContent=text;
    $("callsStatus").classList.toggle("calls-error",error);
  }
  function reportError(err){status(String(err?.message||err),true);}
  function showActive(active){
    $("callsLobby").hidden=active;
    $("callsLive").hidden=!active;
    $("callsHangup").disabled=!active;
  }
  function copyId(){return user?.id||"";}
  async function boot(){
    if(client&&user)return;
    if(booting)return booting;
    booting=(async()=>{
      status("Connecting to Supabase…");
      const {createClient}=await import("https://esm.sh/@supabase/supabase-js@2");
      client=createClient(PROJECT_URL,PUBLISHABLE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
      const {data:existing,error:e}=await client.auth.getSession();
      if(e)throw e;
      if(existing.session)user=existing.session.user;
      else {
        const {data,error}=await client.auth.signInAnonymously();
        if(error)throw new Error(error.message+" — check Supabase Anonymous Sign-Ins.");
        user=data.user;
      }
      await client.realtime.setAuth();
      const result=await client.from("profiles").select("display_name").eq("id",user.id).maybeSingle();
      if(result.error)throw result.error;
      profile=result.data;
      $("callsNameForm").hidden=!!profile;
      $("callsLobby").hidden=!profile;
      $("callsLive").hidden=true;
      status(profile?"Ready. Create a private call or enter an invite code.":"Choose a display name before calling.");
    })().catch(error=>{client=null;user=null;reportError(error);throw error;}).finally(()=>{booting=null;});
    return booting;
  }
  function randomSecret(){
    const bytes=new Uint8Array(15);
    crypto.getRandomValues(bytes);
    return [...bytes].map(n=>n.toString(16).padStart(2,"0")).join("");
  }
  async function saveName(event){
    event.preventDefault();
    const name=$("callsName").value.trim();
    if(name.length<2||name.length>24){status("Display name must be 2–24 characters.",true);return;}
    try{
      const {error}=await client.rpc("set_display_name",{p_name:name});
      if(error)throw error;
      profile={display_name:name};
      $("callsIdentity").hidden=true;
      $("callsLobby").hidden=false;
      status("Ready. Only people with your call invite can join.");
    }catch(err){reportError(err);}
  }
  async function createRoom(){
    if(busy||!profile)return;
    busy=true;$("callsCreate").disabled=true;
    try{
      const secret=randomSecret();
      const {data,error}=await client.rpc("create_room",{p_name:"Private video call",p_password:secret});
      if(error)throw error;
      if(!data)throw Error("The room did not return an ID.");
      await enterRoom(data,String(data)+"."+secret);
    }catch(err){reportError(err);}
    finally{busy=false;$("callsCreate").disabled=false;}
  }
  async function joinRoom(){
    if(busy||!profile)return;
    const match=$("callsCode").value.trim().match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{30})$/i);
    if(!match){status("Paste the complete invite code you received.",true);return;}
    busy=true;$("callsJoin").disabled=true;
    try{
      const {error}=await client.rpc("join_room",{p_room_id:match[1],p_password:match[2]});
      if(error)throw error;
      await enterRoom(match[1],match[0]);
    }catch(err){reportError(err);}
    finally{busy=false;$("callsJoin").disabled=false;}
  }
  function send(peerId,data){
    if(!channel||!connected||!user)return Promise.resolve();
    return channel.send({type:"broadcast",event:"call-signal",payload:{from:user.id,to:peerId,...data}})
      .catch(err=>console.warn("[Calls] signaling error",err));
  }
  function makePeer(id){
    if(peers.has(id))return peers.get(id);
    const pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
    const audio=pc.addTransceiver("audio",{direction:"sendrecv"});
    const video=pc.addTransceiver("video",{direction:"sendrecv"});
    if(localMic)audio.sender.replaceTrack(localMic.getAudioTracks()[0]).catch(console.warn);
    if(localCamera)video.sender.replaceTrack(localCamera.getVideoTracks()[0]).catch(console.warn);
    pc.onicecandidate=e=>{if(e.candidate)void send(id,{ice:e.candidate.toJSON()});};
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==="failed")status("Call connection failed. You may need a TURN relay on this network.",true);
      if(pc.connectionState==="connected")status("Connected. Microphone and camera are controlled separately.");
    };
    pc.ontrack=e=>{
      let stream=remoteStreams.get(id);
      if(!stream){stream=new MediaStream();remoteStreams.set(id,stream);}
      if(!stream.getTracks().some(t=>t.id===e.track.id))stream.addTrack(e.track);
      e.track.addEventListener("ended",()=>{try{stream.removeTrack(e.track);}catch{}});
      renderRemote(id,stream);
    };
    peers.set(id,pc);
    candidateQueues.set(id,[]);
    return pc;
  }
  function renderRemote(id,stream){
    let tile=$("callsPeer-"+id);
    if(!tile){
      tile=document.createElement("div");tile.className="calls-tile";
      tile.id="callsPeer-"+id;
      const video=document.createElement("video");
      video.autoplay=true;video.playsInline=true;video.controls=true;
      const label=document.createElement("small");label.textContent="Participant";
      tile.append(video,label);$("callsRemoteGrid").append(tile);
    }
    const video=tile.querySelector("video");
    video.srcObject=stream;
    video.play().catch(()=>{status("Press play on the participant video if audio does not start.");});
  }
  function dropPeer(id){
    const pc=peers.get(id);
    if(pc){pc.ontrack=null;pc.onicecandidate=null;pc.close();}
    peers.delete(id);candidateQueues.delete(id);
    const stream=remoteStreams.get(id);
    if(stream)remoteStreams.delete(id);
    const el=$("callsPeer-"+id);
    if(el){const v=el.querySelector("video");if(v)v.srcObject=null;el.remove();}
  }
  async function makeOffer(id){
    const pc=makePeer(id);
    if(pc.signalingState!=="stable")return;
    await pc.setLocalDescription(await pc.createOffer());
    await send(id,{description:pc.localDescription.toJSON()});
  }
  async function handleSignal(message){
    if(!message||!user||message.to!==user.id||message.from===user.id||!connected)return;
    const id=message.from;
    if(!/^[0-9a-f-]{36}$/i.test(id))return;
    try{
      if(message.leave){dropPeer(id);return;}
      if(!peers.has(id)&&peers.size>=3){status("Calls are limited to four participants.",true);return;}
      const pc=makePeer(id);
      if(message.description){
        const desc=new RTCSessionDescription(message.description);
        if(desc.type==="offer"){
          if(pc.signalingState!=="stable")await pc.setLocalDescription({type:"rollback"});
          await pc.setRemoteDescription(desc);
          await pc.setLocalDescription(await pc.createAnswer());
          await send(id,{description:pc.localDescription.toJSON()});
        }else if(desc.type==="answer"){
          if(pc.signalingState==="have-local-offer")await pc.setRemoteDescription(desc);
        }
        const pending=candidateQueues.get(id)||[];
        candidateQueues.set(id,[]);
        for(const ice of pending)await pc.addIceCandidate(ice).catch(console.warn);
      }else if(message.ice){
        if(pc.remoteDescription)await pc.addIceCandidate(message.ice);
        else candidateQueues.get(id).push(message.ice);
      }
    }catch(err){console.warn("[Calls] connection signaling",err);status("Could not negotiate call: "+(err.message||err),true);}
  }
  async function syncPeers(){
    if(!channel||!connected)return;
    const participants=new Set(Object.keys(channel.presenceState()).filter(id=>id!==user.id));
    for(const id of [...peers.keys()])if(!participants.has(id))dropPeer(id);
    for(const id of participants){
      if(peers.has(id)||peers.size>=3)continue;
      if(user.id<id)await makeOffer(id).catch(reportError);
    }
    $("callsCount").textContent=String(participants.size+1)+" participant(s)";
  }
  async function enterRoom(id,code){
    if(channel)await hangup();
    roomId=id;invite=code;closed=false;connected=false;
    $("callsInvite").value=code;
    $("callsCode").value="";
    showActive(true);
    status("Connecting to private call…");
    const myChannel=client.channel("room:"+id+":voice",{config:{private:true,presence:{key:user.id}}});
    channel=myChannel;
    myChannel.on("broadcast",{event:"call-signal"},({payload})=>{void handleSignal(payload);});
    myChannel.on("presence",{event:"sync"},()=>{void syncPeers();});
    myChannel.subscribe(async(state,err)=>{
      if(myChannel!==channel||closed)return;
      if(state==="SUBSCRIBED"){
        connected=true;
        try{await myChannel.track({user_id:user.id,display_name:profile.display_name});}
        catch(error){reportError(error);await hangup();return;}
        status("Call joined. Camera and microphone are OFF until you enable them.");
        await syncPeers();
      }else if(state==="CHANNEL_ERROR"||state==="TIMED_OUT"||state==="CLOSED"){
        reportError(err||new Error("Call channel unavailable. Check private Realtime permissions."));
        await hangup();
      }
    });
  }
  async function stopStream(kind){
    const stream=kind==="audio"?localMic:localCamera;
    if(!stream)return;
    if(kind==="audio")localMic=null;else localCamera=null;
    // Stop capture before asynchronous network/peer cleanup, including on Hang up.
    stream.getTracks().forEach(t=>t.stop());
    for(const pc of peers.values()){
      const sender=pc.getTransceivers().find(t=>t.receiver.track.kind===kind)?.sender;
      if(sender)await sender.replaceTrack(null).catch(console.warn);
    }
    if(kind==="video"){$("callsSelfVideo").srcObject=null;$("callsSelfVideo").hidden=true;}
    updateButtons();
  }
  function updateButtons(){
    $("callsMic").textContent=localMic?"Mute microphone":"Turn microphone on";
    $("callsCamera").textContent=localCamera?"Turn camera off":"Turn front camera on";
    $("callsMic").setAttribute("aria-pressed",String(!!localMic));
    $("callsCamera").setAttribute("aria-pressed",String(!!localCamera));
  }
  async function toggleMic(){
    if(!channel||!connected)return;
    if(localMic){await stopStream("audio");status("Microphone is off.");return;}
    let captured;
    try{
      captured=await navigator.mediaDevices.getUserMedia({video:false,audio:{echoCancellation:true,noiseSuppression:true}});
      if(!channel||closed){captured.getTracks().forEach(t=>t.stop());return;}
      localMic=captured;
      for(const pc of peers.values()){
        const sender=pc.getTransceivers().find(t=>t.receiver.track.kind==="audio")?.sender;
        if(sender)await sender.replaceTrack(captured.getAudioTracks()[0]);
      }
      updateButtons();status("Microphone on. Other participants can hear you.");
    }catch(err){captured?.getTracks().forEach(t=>t.stop());reportError(err);}
  }
  const rear=/\b(back|rear|bottom|world|environment)\b/i;
  const front=/\b(front|user|integrated|built.in|facetime|webcam)\b/i;
  async function refreshCameras(){
    if(!navigator.mediaDevices?.enumerateDevices)return;
    try{
      const list=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput");
      const select=$("callsDevice"),old=select.value;
      select.replaceChildren(new Option("Front-facing camera (preferred)","auto"));
      for(const [i,d] of list.entries()){
        select.add(new Option(d.label||"Camera "+(i+1),d.deviceId));
      }
      if([...select.options].some(o=>o.value===old))select.value=old;
    }catch(error){console.warn("[Calls] device list",error);}
  }
  async function cameraCapture(){
    const chosen=$("callsDevice").value;
    const defaults={width:{ideal:640},height:{ideal:360},frameRate:{ideal:20,max:24}};
    let stream=await navigator.mediaDevices.getUserMedia({audio:false,video:chosen!=="auto"?
      {...defaults,deviceId:{exact:chosen}}:{...defaults,facingMode:{ideal:"user"}}});
    try {
      if(chosen==="auto"){
        const cameras=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput");
        const active=stream.getVideoTracks()[0]?.label||"";
        const better=rear.test(active)?cameras.find(d=>front.test(d.label)&&!rear.test(d.label)):null;
        if(better?.deviceId){
          // Some Chromebooks choose a downward-facing camera: prefer an identified front camera.
          const next=await navigator.mediaDevices.getUserMedia({audio:false,video:{...defaults,deviceId:{exact:better.deviceId}}});
          stream.getTracks().forEach(t=>t.stop());stream=next;
          $("callsDevice").value=better.deviceId;
        }
      }
      await refreshCameras();
      return stream;
    } catch (error) {
      stream.getTracks().forEach(track=>track.stop());
      throw error;
    }
  }
  async function startCamera(){
    if(!channel||!connected)return;
    let captured=null;
    try{
      $("callsCamera").disabled=true;
      captured=await cameraCapture();
      if(closed||!channel){captured.getTracks().forEach(t=>t.stop());return;}
      const old=localCamera;
      localCamera=captured;
      const track=captured.getVideoTracks()[0];
      for(const pc of peers.values()){
        const sender=pc.getTransceivers().find(t=>t.receiver.track.kind==="video")?.sender;
        if(sender)await sender.replaceTrack(track);
      }
      $("callsSelfVideo").srcObject=captured;
      $("callsSelfVideo").hidden=false;
      await $("callsSelfVideo").play().catch(()=>{});
      old?.getTracks().forEach(t=>t.stop());
      track.addEventListener("ended",()=>{if(localCamera===captured)void stopStream("video");},{once:true});
      updateButtons();
      status("Camera on. Confirm the preview shows the front-facing view. You can change cameras.");
    }catch(err){captured?.getTracks().forEach(t=>t.stop());reportError(err);}
    finally{$("callsCamera").disabled=false;}
  }
  async function toggleCamera(){
    if(localCamera){await stopStream("video");status("Camera is off.");}
    else await startCamera();
  }
  async function hangup(){
    closed=true;connected=false;
    // Release camera and microphone immediately, even if Supabase is offline.
    for(const stream of [localMic,localCamera])stream?.getTracks().forEach(t=>t.stop());
    localMic=null;localCamera=null;
    $("callsSelfVideo").srcObject=null;
    $("callsSelfVideo").hidden=true;
    updateButtons();
    const ch=channel;channel=null;
    if(ch&&user)for(const id of peers.keys()){
      try{await ch.send({type:"broadcast",event:"call-signal",payload:{from:user.id,to:id,leave:true}});}catch{}
    }
    for(const id of [...peers.keys()])dropPeer(id);
    if(ch&&client){try{await ch.untrack();}catch{}try{await client.removeChannel(ch);}catch{}}
    await stopStream("audio");await stopStream("video");
    const oldRoom=roomId;roomId=null;invite="";
    $("callsInvite").value="";
    $("callsRemoteGrid").replaceChildren();
    $("callsCount").textContent="0 participants";
    showActive(false);
    if(oldRoom&&user&&client){
      // Opt out of future presence/broadcasts after leaving this call.
      const {error}=await client.from("room_members").delete().eq("room_id",oldRoom).eq("user_id",user.id);
      if(error)console.warn("[Calls] membership cleanup",error);
    }
    status("Call ended. Camera and microphone are off.");
  }
  async function closePanel(){
    await hangup();
    $("callsOverlay").classList.add("hidden");
    $("callsOpen").focus();
  }
  $("callsOpen").addEventListener("click",()=>{
    $("callsOverlay").classList.remove("hidden");
    void boot().catch(()=>{});
  });
  $("callsClose").addEventListener("click",()=>{void closePanel();});
  $("callsNameForm").addEventListener("submit",saveName);
  $("callsCreate").addEventListener("click",()=>{void createRoom();});
  $("callsJoin").addEventListener("click",()=>{void joinRoom();});
  $("callsCopy").addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText(invite);status("Invite copied. Share it only with people you trust.");}
    catch{status("Select and copy the invite code manually.",true);}
  });
  $("callsMic").addEventListener("click",()=>{void toggleMic();});
  $("callsCamera").addEventListener("click",()=>{void toggleCamera();});
  $("callsDevice").addEventListener("change",()=>{if(localCamera)void startCamera();});
  $("callsHangup").addEventListener("click",()=>{void hangup();});
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"&&!$("callsOverlay").classList.contains("hidden")){e.preventDefault();void closePanel();}
  });
  window.addEventListener("pagehide",()=>{
    localMic?.getTracks().forEach(t=>t.stop());localCamera?.getTracks().forEach(t=>t.stop());
    for(const pc of peers.values())pc.close();
  });
  navigator.mediaDevices?.addEventListener?.("devicechange",()=>{if(!$("callsOverlay").classList.contains("hidden"))void refreshCameras();});
  showActive(false);updateButtons();
})();