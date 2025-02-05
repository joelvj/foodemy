import { Menu } from 'lucide-react'


export default function Nav() {
	return (
		<nav className="flex justify-between items-center w-[90%] mx-auto mt-5 ">
			<div className="avatar">
				<div className="w-16 rounded-full">
					<img src="https://img.daisyui.com/images/stock/photo-1534528741775-53994a69daeb.webp" />
				</div>
			</div>
			<Menu size={30} className='mr-5'/>
		</nav>
	)
}
