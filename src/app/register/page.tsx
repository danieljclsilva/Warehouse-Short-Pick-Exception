import { AuthApp } from "@/components/auth-app";

type RegisterPageProps = {
  searchParams: Promise<{ token?: string | string[]; invite?: string | string[] }>;
};

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const query = await searchParams;
  const token = Array.isArray(query.token) ? query.token[0] : query.token;
  const invite = Array.isArray(query.invite) ? query.invite[0] : query.invite;
  return <AuthApp key="register" initialView="register" initialInviteToken={token || invite || ""} />;
}
