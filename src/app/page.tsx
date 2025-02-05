import Nav from "@/components/Nav";
import Main from "@/components/Main";
import Options from "@/components/Options";

export default function Home() {
  return (
  <div className="flex flex-col h-full min-h-[100vh]">
      <Nav />
      <Main />
      <Options />
    </div>
    );
}
