import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";


const authKey = process.env.GOOGLE_API_KEY
const genAI = new GoogleGenerativeAI(`${authKey}`)
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash'})


let conversationHistory = []

export async function GET(){
return NextResponse.json({
    Hello: "World"
  })
}

export async function POST(request){
const data = await request.json()
const userMessage = data.prompt

console.log(userMessage)
conversationHistory.push({ role: 'user', parts: [{ text: userMessage }] })

console.log(conversationHistory)

const chat   = await model.startChat({
    history: conversationHistory
  })
 const result = await chat.sendMessage(conversationHistory[0].parts[0].text)
const output = result.response.text()
return(NextResponse.json({
    output
  }))

}
