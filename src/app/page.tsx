'use client'
import Nav from "@/components/Nav";
import Main from "@/components/Main";
import Options from "@/components/Options";
import Logo from "@/components/Logo"
import Chatbox from '@/components/Chatbox'
import { useState } from 'react'
export default function Home() {

  const [currentState, setCurrentState] = useState('first-question')
  function changeState() {
    setCurrentState(currentState === 'first-question' ? 'chatting' : 'first-question')
  }

  return (
    <div className="flex flex-col h-full min-h-[100vh]">
      {currentState === 'first-question' ? (
        <>
          <Nav />
          <Logo />
          <Main />
          <Options />
          <button onClick={changeState} className="border-2 border-white w-72 rounded-xl text-2xl font-bold mx-auto mt-10 hover:bg-white hover:text-black hover:cursor-pointer hover:transition hover:duration-200">Chatting</button>
        </>
      ) : (
        <>
          <Nav />
          <Logo />
          <Chatbox />
          <Main />
          <Options />
          <button onClick={changeState} className="border-2 border-white w-72 rounded-xl text-2xl font-bold mx-auto mt-10 hover:bg-white hover:text-black hover:cursor-pointer hover:transition hover:duration-200">Chatting</button>
        </>
      )}
    </div>
  )
}

