import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { OnlineProviderError } from '../types/onlineMusic';
import type { ProviderUser, QrLoginState } from '../types/onlineMusic';
import { getQishuiWebApiBase } from '../services/onlineMusic/qishuiTransport';
import { qishuiProvider } from '../services/onlineMusic/qishuiProvider';

// src/screens/LoginDialog.tsx — 汽水扫码登录弹框（主页头像唤起）。
// getQrKey → createQr（一步返 token + 二维码图）→ 2s 轮询 checkQr；
// confirmed 即拉登录态并回调 onLoggedIn 关闭弹框，不在弹框内停留。

type DialogPhase =
    | { kind: 'loading' }
    | { kind: 'qr'; token: string; image: string }
    | { kind: 'failed'; message: string };

const POLL_INTERVAL_MS = 2000;

const describeError = (error: unknown): string => {
    if (error instanceof OnlineProviderError) {
        if (error.code === 'network' || error.code === 'unavailable') {
            return `无法连接汽水服务（${getQishuiWebApiBase() ?? 'API 未配置'}）。请确认服务端 qishui-api 正在运行，且与本机在同一网络内可达。`;
        }
        return `登录服务异常：${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
};

interface LoginDialogProps {
    onLoggedIn: (user: ProviderUser) => void;
    onClose: () => void;
}

export default function LoginDialog({ onLoggedIn, onClose }: LoginDialogProps) {
    const [phase, setPhase] = useState<DialogPhase>({ kind: 'loading' });
    const [qrStatus, setQrStatus] = useState<QrLoginState | null>(null);
    const [pollError, setPollError] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement | null>(null);

    const auth = qishuiProvider.auth!;

    const startQrFlow = useCallback(async () => {
        setQrStatus(null);
        setPollError(null);
        setPhase({ kind: 'loading' });
        try {
            const token = await auth.getQrKey!();
            const image = await auth.createQr!(token);
            setPhase({ kind: 'qr', token, image });
            setQrStatus({ state: 'waiting' });
        } catch (error) {
            setPhase({ kind: 'failed', message: describeError(error) });
        }
    }, [auth]);

    useEffect(() => {
        void startQrFlow();
        // 弹框内不再自动重查登录态：主页挂载时已查过，未登录才可能打开本弹框。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 扫码轮询：confirmed 直接收尾回调；expired/error 停表；网络抖动不断表。
    useEffect(() => {
        if (phase.kind !== 'qr') return;
        const token = phase.token;
        let stopped = false;
        let consecutiveFailures = 0;

        const timer = window.setInterval(() => {
            void (async () => {
                if (stopped) return;
                try {
                    const state = await auth.checkQr!(token);
                    if (stopped) return;
                    consecutiveFailures = 0;
                    setPollError(null);
                    setQrStatus(state);
                    if (state.state === 'confirmed') {
                        window.clearInterval(timer);
                        try {
                            const user = await auth.getLoginStatus();
                            if (user) onLoggedIn(user);
                            else setPhase({ kind: 'failed', message: '扫码已确认但未能取得登录态，请重新扫码。' });
                        } catch (error) {
                            setPhase({ kind: 'failed', message: describeError(error) });
                        }
                        return;
                    } else if (state.state === 'expired' || state.state === 'error') {
                        stopped = true;
                        window.clearInterval(timer);
                    }
                } catch {
                    consecutiveFailures += 1;
                    if (consecutiveFailures >= 3 && !stopped) {
                        setPollError('轮询连接失败，请检查 adb reverse 是否还在。');
                    }
                }
            })();
        }, POLL_INTERVAL_MS);

        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [phase, auth, onLoggedIn]);

    // 弹框打开即抢焦点，遥控器 OK/方向键直达弹框内容。
    useEffect(() => {
        dialogRef.current?.focus();
    }, [phase.kind, qrStatus?.state]);

    const statusLine = (() => {
        switch (qrStatus?.state) {
            case 'waiting': return '请用抖音 APP 扫描二维码';
            case 'scanned': return '已扫描，请在手机上确认';
            case 'confirmed': return '已确认，正在登录…';
            case 'expired': return '二维码已过期，请刷新';
            case 'error': return '登录失败，请刷新重试';
            default: return '';
        }
    })();
    const statusClass = qrStatus?.state === 'scanned' || qrStatus?.state === 'confirmed'
        ? 'ok'
        : qrStatus?.state === 'expired' || qrStatus?.state === 'error' ? 'bad' : '';

    return (
        <div className="dialog-overlay" role="dialog" aria-label="扫码登录" data-focus-trap="true">
            <div className="dialog-card login-dialog" ref={dialogRef} tabIndex={-1}>
                <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭">
                    <X size={22} strokeWidth={2} />
                </button>
                <h2 className="dialog-title">扫码登录</h2>
                {phase.kind === 'loading' && <p className="login-status-line">正在连接汽水服务…</p>}
                {phase.kind === 'failed' && (
                    <>
                        <p className="login-error">{phase.message}</p>
                        <button type="button" className="tv-btn" onClick={() => void startQrFlow()}>重试</button>
                    </>
                )}
                {phase.kind === 'qr' && (
                    <>
                        <img className="qr-image" src={phase.image} alt="登录二维码" />
                        <p className={`login-status-line ${statusClass}`}>{statusLine}</p>
                        {pollError && <p className="login-error">{pollError}</p>}
                        <button type="button" className="tv-btn" onClick={() => void startQrFlow()}>刷新二维码</button>
                    </>
                )}
            </div>
        </div>
    );
}
