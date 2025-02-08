import { Pacifico } from "next/font/google"
const pacifico = Pacifico({
	weight: ['400'], 
	subsets: ['latin'], 
	display: 'swap',
})
export default function Logo() {
	return (
		<>
			<div className="mx-auto mt-52">
				<h1 className={`text-[50px] ${pacifico.className} mb-5`}>Foodemy</h1>
			</div>
		</>
	)
} 
