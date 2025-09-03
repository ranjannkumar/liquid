import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '../supabase/supabaseClient.ts';

const AuthPage = () => {
  return (
    <div className="auth-container">
      <div className="auth-box">
        <h1 className="auth-title">Welcome to LayerVibe</h1>
        <p className="auth-subtitle">Sign in to test the application's features.</p>
        <Auth
          supabaseClient={supabase}
          appearance={{ theme: ThemeSupa }}
          providers={['github']} // For simple social login without password/email confirmation
          view="magic_link"       // Use magic_link view to bypass email confirmation
        />
      </div>
    </div>
  );
};

export default AuthPage;