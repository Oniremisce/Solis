import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ProviderUser } from '../types/onlineMusic';
import { qishuiProvider } from '../services/onlineMusic/qishuiProvider';

// src/screens/UserDialog.tsx — 已登录用户信息面板（主页头像唤起）。
// 展示头像与昵称，提供退出登录；退出即清本地会话并回调 onLogout。

interface UserDialogProps {
    user: ProviderUser;
    onLogout: () => void;
    onClose: () => void;
}

export default function UserDialog({ user, onLogout, onClose }: UserDialogProps) {
    const dialogRef = useRef<HTMLDivElement | null>(null);
    // 弹框打开即抢焦点：遥控器/键桥方向键立刻在弹框内导航。
    useEffect(() => { dialogRef.current?.focus(); }, []);

    return (
        <div className="dialog-overlay" role="dialog" aria-label="账号信息" data-focus-trap="true">
            <div className="dialog-card user-dialog" ref={dialogRef} tabIndex={-1}>
                <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">
                    <X size={22} strokeWidth={2} />
                </button>
                {user.avatarUrl
                    ? <img className="user-avatar" src={user.avatarUrl} alt="" />
                    : <div className="user-avatar user-avatar-fallback">{user.nickname.slice(0, 1)}</div>}
                <p className="user-name">{user.nickname}</p>
                <p className="login-status-line ok">已登录 · 汽水音乐</p>
                <button type="button" className="tv-btn" onClick={() => { void qishuiProvider.auth!.logout().then(onLogout); }}>
                    退出登录
                </button>
            </div>
        </div>
    );
}
