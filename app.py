import os
import warnings
warnings.filterwarnings('ignore')
os.environ['HF_HUB_DISABLE_SYMLINKS_WARNING'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from huggingface_hub import HfApi
import PyPDF2
import docx
import pandas as pd
from dotenv import load_dotenv
from functools import wraps
import json
from datetime import timedelta
import traceback
import time
import re
import uuid
import requests
from urllib.parse import quote

# Try to import DuckDuckGo search
try:
    from duckduckgo_search import DDGS
    DDGS_AVAILABLE = True
    print("✅ DuckDuckGo Search library loaded (FREE & PERMANENT)")
except ImportError:
    DDGS_AVAILABLE = False
    print("⚠️ duckduckgo-search not installed. Run: pip install duckduckgo-search")
    print("⚠️ Using fallback search method")

load_dotenv()

# ========== HUGGING FACE SECRETS SUPPORT ==========
def load_hf_secrets():
    secrets_dir = '/run/secrets'
    if os.path.exists(secrets_dir):
        for secret_name in os.listdir(secrets_dir):
            secret_path = os.path.join(secrets_dir, secret_name)
            try:
                with open(secret_path, 'r') as f:
                    os.environ[secret_name] = f.read().strip()
                print(f"✅ Loaded secret: {secret_name}")
            except Exception as e:
                print(f"⚠️ Could not load {secret_name}: {e}")
    
    for secret_name in ['GROQ_API_KEY', 'SECRET_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 
                         'QDRANT_URL', 'QDRANT_API_KEY', 'HF_TOKEN', 'HF_DATASET']:
        if not os.environ.get(secret_name):
            paths = [f'/etc/secrets/{secret_name}', f'/secrets/{secret_name}', f'/run/secrets/{secret_name}']
            for path in paths:
                if os.path.exists(path):
                    try:
                        with open(path, 'r') as f:
                            os.environ[secret_name] = f.read().strip()
                        print(f"✅ Loaded secret: {secret_name}")
                        break
                    except:
                        pass

load_hf_secrets()

groq_key = os.environ.get('GROQ_API_KEY', 'NOT SET')
print(f"🔑 GROQ_API_KEY: {'SET' if groq_key != 'NOT SET' else 'NOT SET'}")
print(f"🔑 QDRANT_URL: {'SET' if os.environ.get('QDRANT_URL') else 'NOT SET'}")

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 32 * 1024 * 1024
app.config['UPLOAD_FOLDER'] = 'uploads'
app.secret_key = os.getenv('SECRET_KEY', 'your-secret-key-change-this')
app.permanent_session_lifetime = timedelta(hours=24)

ADMIN_USERNAME = os.getenv('ADMIN_USERNAME', 'admin')
ADMIN_PASSWORD_HASH = generate_password_hash(os.getenv('ADMIN_PASSWORD', 'Admin@123'))

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

print("\n" + "="*60)
print("🔄 INITIALIZING...")
print("="*60)

try:
    embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    print("✅ Embedding model loaded")
except:
    embedding_model = None
    print("❌ Embedding failed")

qdrant_client = None
try:
    qdrant_url = os.getenv('QDRANT_URL')
    qdrant_api_key = os.getenv('QDRANT_API_KEY')
    
    if qdrant_url and qdrant_api_key:
        qdrant_client = QdrantClient(url=qdrant_url, api_key=qdrant_api_key)
        
        collections = qdrant_client.get_collections().collections
        collection_names = [c.name for c in collections]
        
        if "university_notes" not in collection_names:
            qdrant_client.create_collection(
                collection_name="university_notes",
                vectors_config=VectorParams(size=384, distance=Distance.COSINE)
            )
            print("✅ Qdrant collection created")
        else:
            info = qdrant_client.get_collection("university_notes")
            print(f"✅ Qdrant connected ({info.points_count} documents)")
    else:
        print("⚠️ Qdrant credentials not found")
except Exception as e:
    print(f"❌ Qdrant connection failed: {e}")
    qdrant_client = None

hf_api = None
hf_dataset = os.getenv('HF_DATASET', '')
try:
    hf_token = os.getenv('HF_TOKEN')
    if hf_token and hf_dataset:
        hf_api = HfApi(token=hf_token)
        print(f"✅ HF Dataset ready: {hf_dataset}")
    else:
        print("⚠️ HF Dataset credentials not found")
except Exception as e:
    print(f"⚠️ HF Dataset setup failed: {e}")

groq_api_key = os.getenv('GROQ_API_KEY')
groq_client = None
groq_connected = False

if groq_api_key:
    try:
        from groq import Groq
        groq_client = Groq(api_key=groq_api_key)
        print("✅ Groq client created")
        groq_connected = True
    except:
        try:
            import requests
            print("✅ Using HTTP fallback for Groq")
            groq_client = "http_fallback"
            groq_connected = True
        except:
            print("❌ Groq failed")

print("="*60 + "\n")

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'admin_logged_in' not in session:
            return redirect(url_for('admin_login_page'))
        return f(*args, **kwargs)
    return decorated_function

def extract_text_from_pdf(file_path):
    text = ""
    try:
        with open(file_path, 'rb') as file:
            reader = PyPDF2.PdfReader(file)
            for page in reader.pages:
                page_text = page.extract_text()
                if page_text and len(page_text.strip()) > 10:
                    text += page_text + "\n"
    except:
        pass
    
    if len(text.strip()) < 100:
        try:
            from pdf2image import convert_from_path
            import pytesseract
            images = convert_from_path(file_path, dpi=150)
            ocr_text = ""
            for img in images:
                page_text = pytesseract.image_to_string(img)
                if page_text.strip():
                    ocr_text += page_text + "\n"
            if len(ocr_text) > len(text):
                text = ocr_text
        except:
            pass
    return text

def extract_text_from_docx(file_path):
    try:
        doc = docx.Document(file_path)
        return "\n".join([p.text for p in doc.paragraphs if p.text.strip()])
    except:
        return ""

def extract_text_from_txt(file_path):
    for enc in ['utf-8', 'latin-1', 'cp1252']:
        try:
            with open(file_path, 'r', encoding=enc) as f:
                return f.read()
        except:
            continue
    return ""

def clean_text(text):
    text = re.sub(r'\n\s*\n\s*\n+', '\n\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'image\[\[.*?\]\]', '', text)
    text = re.sub(r'\b\d{1,2}/\d{1,2}/\d{2,4}\b', '', text)
    text = re.sub(r'<center>.*?</center>', '', text, flags=re.DOTALL)
    return text.strip()

def chunk_text(text, size=500, overlap=50):
    paragraphs = re.split(r'\n\s*\n', text)
    chunks = []
    current = ""
    for para in paragraphs:
        para = para.strip()
        if not para or len(para) < 20:
            continue
        if len(current) + len(para) < size:
            current += para + "\n\n"
        else:
            if current.strip():
                chunks.append(current.strip())
            current = para + "\n\n"
    if current.strip():
        chunks.append(current.strip())
    return chunks if chunks else [text[:size]]

def groq_chat_completion(messages, model="llama-3.1-8b-instant", max_tokens=150, temperature=0.7):
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {groq_api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature
    }
    response = requests.post(url, json=payload, headers=headers, timeout=30)
    if response.status_code == 200:
        return response.json()["choices"][0]["message"]["content"]
    else:
        raise Exception(f"Groq API error: {response.status_code}")

def upload_to_hf_dataset(file_path, filename):
    if not hf_api or not hf_dataset:
        print("⚠️ HF Dataset not configured - skipping backup")
        return False
    try:
        path_in_repo = f"documents/{filename}"
        hf_api.upload_file(
            path_or_fileobj=file_path,
            path_in_repo=path_in_repo,
            repo_id=hf_dataset,
            repo_type="dataset"
        )
        print(f"✅ Backed up to HF: {filename}")
        return True
    except Exception as e:
        print(f"⚠️ HF backup failed: {e}")
        return False

# ========== DUCKDUCKGO WEB SEARCH (FREE & UNLIMITED) ==========

def search_web_duckduckgo(query, max_results=3):
    """
    Search the web using DuckDuckGo - completely free, no API key needed.
    This is the primary search method.
    """
    if not DDGS_AVAILABLE:
        print("⚠️ DuckDuckGo library not available, trying fallback...")
        return search_web_fallback(query, max_results)
    
    try:
        print(f"🔍 Searching DuckDuckGo for: {query}")
        results = []
        
        with DDGS() as ddgs:
            # Perform the search
            search_results = list(ddgs.text(query, max_results=max_results))
            
            for r in search_results:
                results.append({
                    "title": r.get("title", ""),
                    "snippet": r.get("body", ""),
                    "link": r.get("href", ""),
                    "source": "DuckDuckGo"
                })
            
            if results:
                print(f"✅ DuckDuckGo found {len(results)} results")
                return results
            else:
                print(f"⚠️ No results found for: {query}")
                return None
                
    except Exception as e:
        print(f"DuckDuckGo search error: {e}")
        # Try fallback method
        return search_web_fallback(query, max_results)

def search_web_fallback(query, max_results=3):
    """
    Fallback search method using DuckDuckGo's Instant Answer API.
    Works without the duckduckgo-search library.
    """
    try:
        print(f"🔍 Using fallback search for: {query}")
        encoded_query = quote(query)
        url = f"https://api.duckduckgo.com/?q={encoded_query}&format=json&no_html=1&skip_disambig=1"
        
        response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=10)
        
        if response.status_code == 200:
            data = response.json()
            results = []
            
            # Extract abstract (main answer)
            if data.get('AbstractText'):
                results.append({
                    "title": data.get('Heading', query),
                    "snippet": data.get('AbstractText', ''),
                    "link": data.get('AbstractURL', ''),
                    "source": "DuckDuckGo (Instant Answer)"
                })
            
            # Extract related topics
            for topic in data.get('RelatedTopics', [])[:max_results-1]:
                if isinstance(topic, dict) and topic.get('Text'):
                    # Parse the text to separate title and content
                    text = topic.get('Text', '')
                    parts = text.split(' - ', 1)
                    title = parts[0] if parts else text[:50]
                    content = parts[1] if len(parts) > 1 else text
                    
                    results.append({
                        "title": title,
                        "snippet": content,
                        "link": topic.get('FirstURL', ''),
                        "source": "DuckDuckGo (Related)"
                    })
            
            if results:
                print(f"✅ Fallback search found {len(results)} results")
                return results
            else:
                print(f"⚠️ No results from fallback search")
                return None
        else:
            print(f"⚠️ Fallback search HTTP error: {response.status_code}")
            return None
            
    except Exception as e:
        print(f"Fallback search error: {e}")
        return None

def search_web(query):
    """
    Main search function - tries primary method first, then fallback.
    Returns list of search results or None if no results found.
    """
    # First try primary DuckDuckGo search
    results = search_web_duckduckgo(query)
    
    # If primary fails, try fallback
    if not results:
        results = search_web_fallback(query)
    
    return results

def needs_real_time_info(user_message):
    """Detect if the question needs real-time/current information"""
    user_lower = user_message.lower()
    
    real_time_indicators = [
        'current', 'latest', 'today', 'now', '2024', '2025', '2026',
        'president', 'prime minister', 'election', 'news', 'recent',
        'weather', 'stock', 'price', 'score', 'live', 'update', 'breaking',
        'who is the', 'who is current', 'currently', 'right now',
        'what is the latest', 'what happened', 'yesterday', 'this week',
        'this month', 'this year', 'newest', 'recently'
    ]
    
    return any(indicator in user_lower for indicator in real_time_indicators)

# ==================== ROUTES ====================

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/admin')
def admin_login_page():
    if 'admin_logged_in' in session:
        return redirect(url_for('admin_panel'))
    return render_template('admin_login.html')

@app.route('/admin/login', methods=['POST'])
def admin_login():
    data = request.json
    if data.get('username') == ADMIN_USERNAME and check_password_hash(ADMIN_PASSWORD_HASH, data.get('password', '')):
        session.permanent = True
        session['admin_logged_in'] = True
        return jsonify({'success': True})
    return jsonify({'success': False, 'message': 'Invalid credentials'}), 401

@app.route('/admin/logout')
def admin_logout():
    session.pop('admin_logged_in', None)
    return redirect(url_for('admin_login_page'))

@app.route('/admin/panel')
@admin_required
def admin_panel():
    return render_template('admin.html')

@app.route('/admin/upload', methods=['POST'])
@admin_required
def upload_file():
    if 'files' not in request.files:
        return jsonify({'error': 'No files'}), 400
    
    files = request.files.getlist('files')
    category = request.form.get('category', '')
    uploaded = []
    failed = []
    
    for file in files:
        if not file.filename:
            continue
        try:
            filename = secure_filename(file.filename)
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(file_path)
            file_type = filename.split('.')[-1].lower()
            
            if file_type == 'pdf':
                text = extract_text_from_pdf(file_path)
            elif file_type == 'docx':
                text = extract_text_from_docx(file_path)
            elif file_type == 'txt':
                text = extract_text_from_txt(file_path)
            elif file_type in ['csv', 'xlsx', 'xls']:
                try:
                    df = pd.read_csv(file_path) if file_type == 'csv' else pd.read_excel(file_path)
                    text = df.to_string()
                except:
                    text = ""
            else:
                text = extract_text_from_txt(file_path)
            
            text = clean_text(text)
            
            if text and len(text.strip()) > 50:
                chunks = chunk_text(text)
                points = []
                for i, chunk in enumerate(chunks):
                    embedding = embedding_model.encode(chunk).tolist()
                    point_id = str(uuid.uuid4())
                    points.append(PointStruct(
                        id=point_id,
                        vector=embedding,
                        payload={
                            "filename": filename,
                            "text": chunk,
                            "chunk_index": i,
                            "category": category,
                            "file_type": file_type,
                            "upload_date": str(pd.Timestamp.now())
                        }
                    ))
                
                if qdrant_client:
                    qdrant_client.upsert(collection_name="university_notes", points=points)
                    print(f"✅ Qdrant: {filename} ({len(chunks)} chunks)")
                
                upload_to_hf_dataset(file_path, filename)
                uploaded.append({'name': filename, 'type': file_type.upper(), 'chunks': len(chunks)})
            else:
                failed.append({'name': filename, 'reason': 'No text extracted'})
            
            if os.path.exists(file_path):
                os.remove(file_path)
        except Exception as e:
            print(f"❌ {file.filename}: {e}")
            failed.append({'name': file.filename, 'reason': str(e)})
    
    return jsonify({'success': True, 'uploaded': uploaded, 'failed': failed})

@app.route('/chat', methods=['POST'])
def chat():
    try:
        data = request.json
        user_message = data.get('message', '').strip()
        
        if not user_message:
            return jsonify({'response': 'Please type a message.'}), 400
        if not groq_client:
            return jsonify({'response': 'AI service not available.'}), 500
        
        user_lower = user_message.lower().strip()
        
        # Classification
        question_words = ['what', 'who', 'where', 'when', 'why', 'how', 'which', 'whose', 'whom', 'can you', 'could you', 'tell me', 'explain', 'define', 'describe']
        is_question = any(user_lower.startswith(q) for q in question_words) or user_message.strip().endswith('?')
        
        greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'sup', 'yo', 'hola', 'hii', 'heyy', 'helloo', 'morning', 'evening', 'good day']
        is_greeting = any(user_lower == g or user_lower.startswith(g + ' ') for g in greetings) and len(user_message.split()) <= 3 and not is_question
        
        identity_q = ['who are you', 'what are you', 'your name', 'about yourself', 'introduce yourself', 'tell me about yourself', 'who created you', 'are you ai', 'are you human', 'are you real']
        location_q = ['where are you', 'where do you live', 'your country', 'which country', 'where you from', 'your location']
        user_personal_q = ['know my name', 'do you know me', 'who am i', 'what is my name', 'remember me']
        
        is_identity = any(q in user_lower for q in identity_q)
        is_location = any(q in user_lower for q in location_q) 
        is_user_personal = any(q in user_lower for q in user_personal_q)
        is_about_ai = is_identity or is_location
        
        thanks_words = ['thank', 'thanks', 'thx', 'appreciate']
        is_thanks = any(t in user_lower for t in thanks_words) and len(user_message.split()) <= 4 and not is_question
        
        # Check if needs real-time info
        needs_realtime = needs_real_time_info(user_message)
        
        is_casual = is_greeting or is_thanks or is_about_ai or is_user_personal
        
        # ========== WEB SEARCH FOR REAL-TIME INFO ==========
        web_results = None
        if needs_realtime and not is_casual:
            print(f"🔍 REAL-TIME QUERY DETECTED: {user_message}")
            web_results = search_web(user_message)
            if web_results:
                print(f"✅ Got {len(web_results)} web results for real-time answer")
            else:
                print(f"⚠️ No web results found, will use general knowledge")
        
        # ========== SEARCH DOCUMENTS ==========
        doc_context = ""
        sources = []
        
        if qdrant_client and embedding_model and not is_casual and not web_results:
            try:
                query_embedding = embedding_model.encode(user_message).tolist()
                search_results = qdrant_client.search(
                    collection_name="university_notes", query_vector=query_embedding, limit=3
                )
                if search_results:
                    texts = []
                    for hit in search_results:
                        payload = hit.payload
                        filename = payload.get('filename', 'Unknown')
                        if filename not in sources:
                            sources.append(filename)
                        texts.append(payload.get('text', ''))
                    if texts:
                        doc_context = "\n\n".join(texts[:3])
                        print(f"📚 Found relevant documents: {len(sources)} sources")
            except Exception as e:
                print(f"Document search error: {e}")
        
        # ========== BUILD PROMPT BASED ON CONTEXT ==========
        
        if is_greeting:
            system_prompt = "You are a friendly AI assistant. Respond with a SHORT, warm greeting. 1 sentence only."
            user_prompt = f"User: {user_message}\n\nShort greeting:"
            max_tokens = 50
            
        elif is_identity:
            system_prompt = """You are an AI assistant. Tell them: You're an AI created to help people learn. No physical form. 2-3 friendly sentences."""
            user_prompt = f"User: {user_message}\n\nFriendly AI response:"
            max_tokens = 100
            
        elif is_location:
            system_prompt = """You are an AI assistant. Explain you don't have a physical location - you exist in the cloud. 2 friendly sentences."""
            user_prompt = f"User: {user_message}\n\nFriendly response:"
            max_tokens = 80
            
        elif is_user_personal:
            system_prompt = "You are an AI assistant. Honestly say you don't know their name but you're happy to help. 2 friendly sentences."
            user_prompt = f"User: {user_message}\n\nHonest response:"
            max_tokens = 60
            
        elif is_thanks:
            system_prompt = "Respond to thanks warmly in 1 short sentence."
            user_prompt = f"User: {user_message}\n\nResponse:"
            max_tokens = 30
            
        elif web_results:
            # REAL-TIME MODE: Use web search results
            web_context = ""
            for idx, r in enumerate(web_results, 1):
                web_context += f"[{idx}] {r.get('title', 'No title')}\n"
                web_context += f"    {r.get('snippet', 'No content')}\n"
                if r.get('link'):
                    web_context += f"    Source: {r.get('link')}\n"
                web_context += "\n"
            
            system_prompt = """You are a knowledgeable AI assistant with access to REAL-TIME web search results.

IMPORTANT RULES:
1. Answer based on the LATEST real-time web search results provided below
2. Use CURRENT information (today's date and current events)
3. Be conversational and helpful - don't sound like a robot
4. If the web results contain the answer, state it clearly and confidently
5. Cite information naturally (e.g., "According to recent reports..." not "The search results show...")
6. Keep your answer concise - 3-5 sentences for most questions
7. If the question asks about a specific person/event, give the most up-to-date information

Remember: You're providing REAL-TIME information, not outdated knowledge!"""
            
            user_prompt = f"""Question from user: {user_message}

REAL-TIME WEB SEARCH RESULTS:
{web_context}

Based on these current search results, provide an accurate, up-to-date answer:"""
            max_tokens = 300
            
        elif doc_context:
            system_prompt = """You are a helpful AI tutor using study materials.
IMPORTANT: NEVER mention "study notes", "documents", "files", or "PDFs".
Just give the answer as if you know it naturally. Be clear and conversational. 3-5 sentences max."""
            
            user_prompt = f"""Reference information (use silently, never mention):
{doc_context[:1000]}
Question: {user_message}
Natural answer based on the above (but don't mention the source):"""
            max_tokens = 250
            
        else:
            system_prompt = """You are a smart, knowledgeable AI assistant. Answer naturally using your general knowledge.
Be conversational and helpful. 3-5 sentences for explanations, 2-3 for definitions.
You can answer ANY topic - science, history, math, technology, current events, etc.
If you don't know something, say so honestly."""
            
            user_prompt = f"Question: {user_message}\n\nNatural, conversational answer:"
            max_tokens = 300
        
        # ========== GET RESPONSE FROM GROQ ==========
        response_text = None
        models_to_try = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"]
        
        if groq_client == "http_fallback":
            for model in models_to_try:
                try:
                    response_text = groq_chat_completion(
                        messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                        model=model, max_tokens=max_tokens, temperature=0.7
                    )
                    if response_text:
                        break
                except Exception as e:
                    print(f"Model {model} failed: {e}")
                    continue
        else:
            for model in models_to_try:
                try:
                    completion = groq_client.chat.completions.create(
                        model=model,
                        messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                        temperature=0.7, max_tokens=max_tokens
                    )
                    response_text = completion.choices[0].message.content
                    if response_text:
                        break
                except Exception as e:
                    print(f"Model {model} failed: {e}")
                    continue
        
        # ========== CLEAN UP RESPONSE ==========
        if response_text:
            # Remove markdown formatting
            response_text = re.sub(r'\*{1,3}', '', response_text)
            response_text = re.sub(r'#{1,4}\s*', '', response_text)
            response_text = re.sub(r'\[[0-9]+\]', '', response_text)
            
            # Remove any references to documents/sources for study mode
            if doc_context and not web_results:
                doc_phrases = [
                    r'(?i).*the (documents?|files?|PDFs?|notes).*?\.\s*',
                    r'(?i).*according to.*?\.\s*',
                    r'(?i).*based on.*?\.\s*',
                    r'(?i).*reference material.*?\.\s*',
                ]
                for phrase in doc_phrases:
                    response_text = re.sub(phrase, '', response_text)
            
            response_text = response_text.strip()
            
            # Fallback responses for edge cases
            if is_greeting and (len(response_text) < 3 or len(response_text) > 80):
                response_text = "Hey there! 👋 How can I help you today?"
            if is_about_ai and len(response_text) < 10:
                response_text = "I'm an AI assistant! I don't have a physical location - I exist in the cloud to help you learn and answer questions. 😊"
            if is_thanks and len(response_text) > 40:
                response_text = "You're welcome! 😊"
            if not response_text or len(response_text) < 2:
                response_text = "How can I help you today?"
            
            # Determine response mode for UI
            if web_results:
                mode = "realtime"
                print(f"💡 Responded with REAL-TIME info from web")
            elif doc_context:
                mode = "study"
                print(f"📚 Responded using study documents")
            else:
                mode = "general"
                print(f"🧠 Responded using general knowledge")
            
            return jsonify({
                'response': response_text,
                'sources': sources if not web_results else [r.get('link', '') for r in web_results[:2]],
                'mode': mode
            })
        else:
            return jsonify({'response': "I'm having trouble right now. Could you try asking again?"}), 500
            
    except Exception as e:
        print(f"Chat error: {e}")
        traceback.print_exc()
        return jsonify({'response': "Sorry, I encountered an issue. Please try again!"}), 500

@app.route('/check-status', methods=['GET'])
def check_status():
    doc_count = 0
    if qdrant_client:
        try:
            info = qdrant_client.get_collection("university_notes")
            doc_count = info.points_count
        except:
            pass
    
    # Test web search availability
    web_search_available = DDGS_AVAILABLE
    if not web_search_available:
        # Try fallback
        try:
            test_result = search_web_fallback("test", max_results=1)
            web_search_available = test_result is not None
        except:
            web_search_available = False
    
    return jsonify({
        'status': 'online',
        'documents_available': doc_count > 0,
        'document_count': doc_count,
        'api_connected': groq_connected,
        'qdrant_connected': qdrant_client is not None,
        'web_search_available': web_search_available,
        'web_search_provider': 'DuckDuckGo (Free & Unlimited)'
    })

@app.route('/admin/documents', methods=['GET'])
@admin_required
def get_documents():
    docs = []
    if qdrant_client:
        try:
            scroll_results = qdrant_client.scroll(
                collection_name="university_notes", limit=100, with_payload=True, with_vectors=False
            )
            seen = set()
            for point in scroll_results[0]:
                filename = point.payload.get('filename', '')
                if filename and filename not in seen:
                    seen.add(filename)
                    docs.append({
                        'filename': filename,
                        'file_type': point.payload.get('file_type', ''),
                        'category': point.payload.get('category', ''),
                        'upload_date': point.payload.get('upload_date', ''),
                        'doc_id': point.id,
                        'chunks': 1
                    })
        except Exception as e:
            print(f"Error fetching documents: {e}")
    return jsonify({'success': True, 'documents': docs})

@app.route('/admin/delete/<doc_id>', methods=['DELETE'])
@admin_required
def delete_document(doc_id):
    try:
        if qdrant_client:
            qdrant_client.delete(collection_name="university_notes", points_selector=[doc_id])
        return jsonify({'success': True})
    except Exception as e:
        print(f"Delete error: {e}")
        return jsonify({'success': False}), 500

@app.route('/admin/stats')
@admin_required
def get_admin_stats():
    doc_count = 0
    if qdrant_client:
        try:
            info = qdrant_client.get_collection("university_notes")
            doc_count = info.points_count
        except:
            pass
    return jsonify({'success': True, 'total_documents': doc_count, 'total_chunks': doc_count})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 7860))
    doc_count = 0
    if qdrant_client:
        try:
            info = qdrant_client.get_collection("university_notes")
            doc_count = info.points_count
        except:
            pass
    
    print("\n" + "="*60)
    print("🚀 SERVER STARTED")
    print(f"📚 Documents in Qdrant: {doc_count}")
    print(f"🔍 Web Search: DuckDuckGo (FREE & UNLIMITED)")
    print(f"   - Primary: duckduckgo-search library")
    print(f"   - Fallback: DuckDuckGo Instant Answer API")
    print(f"🌐 Web Interface: http://0.0.0.0:{port}/")
    print(f"🔧 Admin Panel: http://0.0.0.0:{port}/admin")
    print("="*60 + "\n")
    
    app.run(host='0.0.0.0', port=port, debug=False)