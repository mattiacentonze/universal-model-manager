#!/usr/bin/env python3
import dbus
import sqlite3
import os
import json
import shutil
import sys
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

BASE_CHROME_DIR = os.path.expanduser('~/.config/google-chrome')

def get_aes_key():
    bus = dbus.SessionBus()
    secrets = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')
    iface = dbus.Interface(secrets, 'org.freedesktop.Secret.Service')
    unlocked, locked = iface.SearchItems({'application': 'chrome'})
    items = list(unlocked) + list(locked)
    if not items:
        return None
    session_path = iface.OpenSession('plain', '')[1]
    item = bus.get_object('org.freedesktop.secrets', items[0])
    secret = dbus.Interface(item, 'org.freedesktop.Secret.Item').GetSecret(session_path)
    password = bytes(secret[2])
    kdf = PBKDF2HMAC(algorithm=hashes.SHA1(), length=16, salt=b'saltysalt', iterations=1)
    return kdf.derive(password)

def list_profiles():
    local_state_path = os.path.join(BASE_CHROME_DIR, 'Local State')
    if not os.path.exists(local_state_path):
        return []
    try:
        with open(local_state_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        info_cache = data.get('profile', {}).get('info_cache', {})
        profiles = []
        for folder, info in info_cache.items():
            cookies_path = os.path.join(BASE_CHROME_DIR, folder, 'Cookies')
            has_cookies = False
            if os.path.exists(cookies_path):
                temp = f'/tmp/check_cookies_{folder.replace(" ", "_")}.db'
                try:
                    shutil.copy(cookies_path, temp)
                    db = sqlite3.connect(temp)
                    cur = db.cursor()
                    cur.execute('SELECT count(*) FROM cookies WHERE host_key LIKE "%chatgpt.com%" AND (name LIKE "%session%" OR name = "oai-sc")')
                    has_cookies = cur.fetchone()[0] > 0
                    db.close()
                    os.remove(temp)
                except:
                    pass
            profiles.append({
                'folder': folder,
                'name': info.get('name', folder),
                'email': info.get('user_name', ''),
                'gaiaName': info.get('gaia_name', ''),
                'hasSession': has_cookies,
            })
        return profiles
    except Exception as e:
        sys.stderr.write(f"List error: {e}\n")
        return []

def extract_cookies(profile_folder='Default'):
    aes_key = get_aes_key()
    if not aes_key:
        return None

    db_path = os.path.join(BASE_CHROME_DIR, profile_folder, 'Cookies')
    if not os.path.exists(db_path):
        return None

    temp_db = f'/tmp/opencode_cookies_{profile_folder.replace(" ", "_")}.db'
    shutil.copy(db_path, temp_db)
    db = sqlite3.connect(temp_db)
    cur = db.cursor()
    cur.execute('SELECT host_key, name, path, is_secure, is_httponly, expires_utc, samesite, encrypted_value, value FROM cookies WHERE host_key LIKE "%chatgpt.com%" OR host_key LIKE "%openai.com%"')
    rows = cur.fetchall()

    def decrypt_val(enc, plain):
        if plain:
            return plain
        if not enc:
            return ''
        if enc.startswith(b'v10') or enc.startswith(b'v11'):
            cipher = Cipher(algorithms.AES(aes_key), modes.CBC(b' ' * 16))
            dec = cipher.decryptor().update(enc[3:]) + cipher.decryptor().finalize()
            pad = dec[-1]
            dec = dec[:-pad]
            if enc.startswith(b'v11'):
                return dec[32:].decode('utf-8', errors='ignore')
            return dec.decode('utf-8', errors='ignore')
        return ''

    same_site_map = {0: 'None', 1: 'Lax', 2: 'Strict'}
    cookies_out = []
    has_auth = False

    for host, name, path, is_secure, is_httponly, expires_utc, samesite, enc, val in rows:
        decrypted = decrypt_val(enc, val)
        if not decrypted:
            continue
        if 'session-token' in name or name == 'oai-sc':
            has_auth = True
        expires_unix = (expires_utc / 1000000) - 11644473600 if expires_utc > 0 else -1
        cookies_out.append({
            'name': name,
            'value': decrypted,
            'domain': host,
            'path': path,
            'expires': expires_unix,
            'httpOnly': bool(is_httponly),
            'secure': bool(is_secure),
            'sameSite': same_site_map.get(samesite, 'Lax'),
        })

    db.close()
    try:
        os.remove(temp_db)
    except:
        pass

    if not has_auth:
        return None
    return cookies_out

if __name__ == "__main__":
    args = sys.argv[1:]
    if "--list" in args:
        print(json.dumps({'profiles': list_profiles()}))
        sys.exit(0)

    target_profile = 'Default'
    if args and not args[0].startswith('-'):
        target_profile = args[0]

    cookies = extract_cookies(target_profile)
    if cookies:
        print(json.dumps({'cookies': cookies, 'origins': [], 'profile': target_profile}))
        sys.exit(0)
    else:
        sys.exit(1)
