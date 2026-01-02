import os
import shutil
import re
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from contextlib import asynccontextmanager  # <--- ADDED THIS

# --- LangChain Providers ---
from langchain_groq import ChatGroq
from langchain_openai import ChatOpenAI
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_chroma import Chroma
from langchain_community.document_loaders import YoutubeLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.documents import Document
from langchain_core.output_parsers import StrOutputParser

# LangGraph
from langgraph.graph import START, END, StateGraph
from typing_extensions import TypedDict

# Audio
import yt_dlp
from groq import Groq
import uuid
from pydub import AudioSegment
import math

os.environ["TOKENIZERS_PARALLELISM"] = "false"

load_dotenv()

# --- OPTIONAL: LANGSMITH TRACING ---
if os.getenv("LANGCHAIN_API_KEY"):
    os.environ["LANGCHAIN_TRACING_V2"] = "true"
    os.environ["LANGCHAIN_PROJECT"] = "YouTube-Chat-RAG-Fusion"

# --- ZOMBIE FILE CLEANUP (Run on Startup) ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Startup Logic: Clean up leftover audio files
    print("🧹 Running startup cleanup...")
    deleted_count = 0
    try:
        for filename in os.listdir("."):
            if filename.endswith(".mp3") and filename.startswith("temp_"):
                try:
                    os.remove(filename)
                    deleted_count += 1
                    print(f"   🗑️ Deleted zombie file: {filename}")
                except Exception as e:
                    print(f"   ⚠️ Could not delete {filename}: {e}")
        
        if deleted_count > 0:
            print(f"✅ Cleanup complete. Removed {deleted_count} stale files.")
        else:
            print("✅ System clean. No stale files found.")
            
    except Exception as e:
        print(f"❌ Cleanup Error: {e}")
        
    yield  # 2. App runs here
    
    # 3. Shutdown Logic (Optional: you can add shutdown cleanup here too)
    print("🛑 Server shutting down...")

# --- APP DEFINITION WITH LIFESPAN ---
app = FastAPI(lifespan=lifespan)  # <--- LINKED LIFESPAN HERE

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- CONFIG ---
DB_FOLDER = "./chroma_db"
DEFAULT_GROQ_KEY = os.getenv("GROQ_API_KEY")
embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")


# --- LLM FACTORY ---
def get_llm(provider: str, api_key: Optional[str]):
    # 1. SYSTEM DEFAULT
    if not api_key:
        return ChatGroq(model_name="llama-3.1-8b-instant", api_key=DEFAULT_GROQ_KEY, temperature=0)
    
    # 2. USER PROVIDERS
    if provider == "openai":
        return ChatOpenAI(model="gpt-4o-mini", api_key=api_key, temperature=0)
    
    elif provider == "gemini":
        return ChatGoogleGenerativeAI(
            model="gemini-2.5-flash", 
            google_api_key=api_key, 
            temperature=0
        )
    
    elif provider == "groq":
        return ChatGroq(model_name="llama-3.1-8b-instant", api_key=api_key, temperature=0)
    
    # 3. FINAL CATCH-ALL
    return ChatGroq(model_name="llama-3.1-8b-instant", api_key=DEFAULT_GROQ_KEY, temperature=0)

# --- UTILS ---
def extract_video_id(url: str):
    regex = r"(?:v=|\/)([0-9A-Za-z_-]{11}).*"
    match = re.search(regex, url)
    return match.group(1) if match else None

def get_vectorstore(video_id: str):
    return Chroma(
        collection_name=f"video_{video_id}",
        embedding_function=embeddings,
        persist_directory=DB_FOLDER 
    )


# --- AUDIO DOWNLOADER ---
def download_audio_and_transcribe(video_url: str):
    print("⚠️ No subtitles found. Falling back to Audio Transcription...")
    groq_client = Groq(api_key=DEFAULT_GROQ_KEY)
    
    session_id = str(uuid.uuid4())
    print(f"   🆔 Session ID: {session_id}")

    base_filename = f"temp_audio_{session_id}"
    audio_filename = f"{base_filename}.mp3"
    
    ydl_opts = {
        'format': 'bestaudio/best',
        'postprocessors': [{'key': 'FFmpegExtractAudio','preferredcodec': 'mp3','preferredquality': '32'}],
        'outtmpl': f"{base_filename}.%(ext)s",
        'quiet': True,
        'js_runtimes': {'node': {}} 
    }
    
    try:
        if os.path.exists(audio_filename): os.remove(audio_filename)
        
        print(f"   Downloading audio to {audio_filename}...")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])
        
        file_size_mb = os.path.getsize(audio_filename) / (1024 * 1024)
        print(f"   Audio File Size: {file_size_mb:.2f} MB")

        full_transcript = ""
        
        if file_size_mb < 24:
            with open(audio_filename, "rb") as file:
                transcription = groq_client.audio.transcriptions.create(
                    file=(audio_filename, file.read()),
                    model="whisper-large-v3-turbo",
                    response_format="json",
                    language="en",
                    temperature=0.0
                )
            full_transcript = transcription.text
            
        else:
            print("   ⚠️ File too large. Splitting into chunks...")
            audio = AudioSegment.from_mp3(audio_filename)
            chunk_length_ms = 10 * 60 * 1000 
            chunks = [audio[i:i + chunk_length_ms] for i in range(0, len(audio), chunk_length_ms)]
            
            print(f"   Processing {len(chunks)} chunks...")
            
            for i, chunk in enumerate(chunks):
                chunk_name = f"temp_chunk_{session_id}_{i}.mp3" 
                chunk.export(chunk_name, format="mp3", bitrate="32k")
                
                with open(chunk_name, "rb") as file:
                    transcription = groq_client.audio.transcriptions.create(
                        file=(chunk_name, file.read()),
                        model="whisper-large-v3-turbo",
                        response_format="json",
                        language="en",
                        temperature=0.0
                    )
                full_transcript += " " + transcription.text
                print(f"     ✅ Chunk {i+1}/{len(chunks)} processed")
                if os.path.exists(chunk_name): os.remove(chunk_name)

        if os.path.exists(audio_filename): os.remove(audio_filename)
        return full_transcript.strip()
        
    except Exception as e:
        if os.path.exists(audio_filename): os.remove(audio_filename)
        for f in os.listdir():
            if f.startswith(f"temp_chunk_{session_id}"):
                os.remove(f)
        print(f"❌ TRANSCRIPTION FAILED: {str(e)}")
        raise e


# --- DATA MODELS ---
class VideoRequest(BaseModel):
    video_url: str

class ChatRequest(BaseModel):
    query: str
    video_url: str
    history: List[dict]

class State(TypedDict):
    original_question: str
    generated_queries: List[str]
    chat_history: List[BaseMessage]
    context: str
    answer: str
    video_id: str
    llm: object 

# --- GRAPH NODES ---

def generate_queries(state: State):
    print(f"--- GENERATING QUERIES for: {state['original_question']} ---")
    llm = state["llm"]
    
    system_prompt = (
        "You are an intelligent YouTube Video Assistant. Your task is to generate 3 different versions "
        "of the user's question to retrieve the most relevant segments from the video transcript. "
        "Provide exactly 3 alternative questions separated by newlines."
    )
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_prompt),
        ("human", "{question}"),
    ])
    
    chain = prompt | llm | StrOutputParser()
    response = chain.invoke({"question": state["original_question"]})
    
    queries = [q.strip() for q in response.split("\n") if q.strip()]
    if not queries: queries = [state["original_question"]]
    
    print(f"Generated: {queries}")
    return {"generated_queries": queries}

def retrieve(state: State):
    print("--- RETRIEVING & FUSING ---")
    vectorstore = get_vectorstore(state["video_id"])
    retriever = vectorstore.as_retriever(search_kwargs={"k": 4}) 
    
    unique_docs = {}
    for query in state["generated_queries"]:
        docs = retriever.invoke(query)
        for doc in docs:
            if doc.page_content not in unique_docs:
                unique_docs[doc.page_content] = doc
                
    final_docs = list(unique_docs.values())[:8]
    context_text = "\n\n".join([d.page_content for d in final_docs])
    return {"context": context_text}

def generate_answer(state: State):
    print("--- GENERATING ANSWER ---")
    llm = state["llm"]
    
    system_prompt = (
        "You are a helpful YouTube assistant. Answer the user's question based ONLY on the context below. "
        "If the answer is not in the context, say 'I cannot find that information in the video'.\n\n"
        "Context from Video:\n{context}"
    )
    
    prompt = ChatPromptTemplate.from_messages([
        ("system", system_prompt),
        MessagesPlaceholder("chat_history"),
        ("human", "{question}"),
    ])
    
    chain = prompt | llm
    response = chain.invoke({
        "context": state["context"], 
        "chat_history": state["chat_history"], 
        "question": state["original_question"]
    })
    
    return {"answer": response.content}

# --- GRAPH BUILD ---
workflow = StateGraph(State)
workflow.add_node("generate_queries", generate_queries)
workflow.add_node("retrieve", retrieve)
workflow.add_node("generate", generate_answer)

workflow.add_edge(START, "generate_queries")
workflow.add_edge("generate_queries", "retrieve")
workflow.add_edge("retrieve", "generate")
workflow.add_edge("generate", END)
app_graph = workflow.compile()

# --- ENDPOINTS ---

@app.post("/process-video")
async def process_video(request: VideoRequest):
    try:
        video_id = extract_video_id(request.video_url)
        if not video_id: raise HTTPException(status_code=400, detail="Invalid URL")
        
        vectorstore = get_vectorstore(video_id)
        if len(vectorstore.get()['ids']) > 0:
            return {"status": "success", "message": "Already processed"}

        print(f"Processing: {video_id}")
        
        try:
            loader = YoutubeLoader.from_youtube_url(request.video_url, add_video_info=False)
            docs = loader.load()
            if not docs or not docs[0].page_content.strip():
                raise ValueError("Transcript is empty or missing")
            print("✅ Loaded Captions")
        except Exception:
            transcript_text = download_audio_and_transcribe(request.video_url)
            if not transcript_text.strip():
                raise ValueError("Audio transcription failed to produce text.")
            docs = [Document(page_content=transcript_text)]
            print("✅ Loaded Audio Transcription")
        
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
        splits = text_splitter.split_documents(docs)
        
        if not splits: raise ValueError("No content could be extracted.")
            
        vectorstore.add_documents(documents=splits)
        return {"status": "success"}

    except Exception as e:
        import traceback
        print(f"❌ CRITICAL ERROR: {str(e)}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat")
async def chat(
    request: ChatRequest,
    x_api_key: Optional[str] = Header(None),
    x_provider: Optional[str] = Header("groq")
):
    video_id = extract_video_id(request.video_url)
    
    # Select the correct LLM
    selected_llm = get_llm(x_provider, x_api_key)

    lc_history = []
    for msg in request.history:
        if msg['role'] == "user": lc_history.append(HumanMessage(content=msg['content']))
        else: lc_history.append(AIMessage(content=msg['content']))

    initial_state = {
        "original_question": request.query,
        "chat_history": lc_history,
        "generated_queries": [],
        "context": "",
        "answer": "",
        "video_id": video_id,
        "llm": selected_llm
    }
    
    try:
        result = app_graph.invoke(initial_state)
        return {"reply": result["answer"]}
    
    except Exception as e:
        error_msg = str(e).lower()
        if "rate limit" in error_msg or "429" in error_msg or "quota" in error_msg or "resource exhausted" in error_msg:
            print("⚠️ API Limit Reached")
            return {
                "reply": "⚠️ **API Limit Reached:** I have hit the usage limit for this model. Please try again in a few minutes or switch to a different provider in Settings."
            }
        
        print(f"❌ Chat Error: {e}")
        return {"reply": "❌ An internal error occurred. Please try again."}