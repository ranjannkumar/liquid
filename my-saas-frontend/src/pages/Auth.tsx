import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '../supabase/supabaseClient.ts';

const AuthPage = () => {
  return (
    <div className="auth-container">
      <div className="auth-box">
        <h1 className="auth-title">Welcome to LayerVibe</h1>
        <p className="auth-subtitle">Sign in or create an account to get started.</p>
        <Auth
          supabaseClient={supabase}
          appearance={{ theme: ThemeSupa }}
          providers={['github']}
        />
      </div>
    </div>
  );
};

export default AuthPage;